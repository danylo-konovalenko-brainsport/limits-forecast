import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { View } from '../types'
import {
  addToBuckets,
  busiestDays,
  calibrate,
  correction,
  DAY,
  dedupeReadings,
  evaluate,
  FAMILIES,
  family,
  FAMILY_CELL,
  FAMILY_LABEL,
  familyBuckets,
  familyWeight,
  fitLine,
  fmtPct,
  forecast,
  hhmm,
  hitReadings,
  HOUR,
  isWorse,
  labelOf,
  LINE_BAR,
  lineParts,
  LOOKBACK_DAYS,
  mergeBuckets,
  mergeHits,
  normReset,
  parseTranscript,
  pastWeeks,
  profile,
  rangeBar,
  regularity,
  reweight,
  scopedLimits,
  scopeOf,
  shortOf,
  startReadings,
  suggestions,
  toLog,
  TRANSCRIPT_LINE,
  tune,
  usageIndex,
  VERDICT_TEXT,
  weightCheck,
  worst,
} from './model'
import type { BarPart, Between, Buckets, Calib, Family, Forecast, ForecastLog, Hit, Limit, LinePart, Profile, Quality, Reading, Tuning, Turn, Verdict } from './model'
import { buildExport, byMonth, emptyLog, forecastEntry, limitHits, logName, parseLog, projectOf, rollupTranscript } from './retro'
import type { DayRow, Log, Rollup } from './retro'
import { forecastRows, hitSummary, LEGEND, report, reportText } from './report'
import type { Row } from './report'

const PANE = 'limits'
const view = atom({ plugin: 'limits-forecast', key: 'view' } as const, null)
const hiddenKey = atom({ plugin: 'limits-forecast', key: 'hiddenKey' } as const, '')
/** The live context window, shown at the end of the line: the one source of it. */
const ctx = atom({ plugin: 'limits-forecast', key: 'ctx' } as const, null)
const kTokens = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1000)}k`)

const MAX_READ = 4 * 1024 * 1024
const FLUSH_MS = 5 * 60_000
/** Whether any surface has drawn the band or the pane; VS Code draws neither, though the engine places the pane. */
let drawsUi = false
const KEEP_MS = 10 * 7 * DAY
/** Readings and forecasts of all sessions are loaded this far back. */
const LOG_DAYS = 40
/** The windows subscription plans have; any other window reported (but a gateway's spend limit) is shown too. */
const KINDS = ['five_hour', 'seven_day']

type FileCache = { size: number; mtimeMs: number; buckets: Buckets; hits: Hit[] }
/** Version 4: four cells per bucket (Fable apart), weighted at the current list prices. */
type HistoryCache = { version: 4; files: Record<string, FileCache> }
type LogFile = { size: number; mtimeMs: number; log: Log }

/**
 * Warning state every session shares through the plugin's store: a new
 * session does not raise a known warning again, a hide holds everywhere, and
 * the verdict of each window is remembered for its hysteresis.
 */
type Shared = { key: string; overall: Verdict; verdicts: Record<string, Verdict>; hidden: string; marks: Record<string, { r: string; m: number[] }> }
const SHARED = 'warning'
const emptyShared = (): Shared => ({ key: '', overall: 'ok', verdicts: {}, hidden: '', marks: {} })

/**
 * Anthropic's usage endpoint, the one /usage reads: the only place a model's
 * own weekly window (Fable's) is reported. Asked at most every 5 minutes by
 * whichever session saw usage, and not for half an hour after a refusal.
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const SCOPED_MS = 5 * 60_000
const SCOPED_BACKOFF_MS = 30 * 60_000
/** The endpoint's last answer, shared by every session: when it was read and when the next ask may go out. */
type Scoped = { at: number; next: number; limits: Limit[] }
const SCOPED = 'scoped'

/** The options, fixed for this activation (a change reloads the module). */
let lineMode: 'full' | 'compact' | 'off' = 'full'
let toasts = true
let modelLimits = true

// This process's own data; values the UI reads live in atoms.
let base = ''
let folder = ''
let sessionKey = ''
let own: Log = emptyLog()
const others = new Map<string, LogFile>()
let liveTurns: Turn[] = []
let scanBuckets: Buckets = {}
let scanAt = 0
let scanning = false
let scanInfo = { files: 0, skipped: 0 }
let scanHits: Hit[] = []
/** When Claude Code last reported the limits: they come with responses only. */
let reportedAt: number | undefined
const lastLive: Record<string, Reading> = {}
/** Whether this session has looked at the models' own windows yet. */
let scopedSeen = false
const logLines: Record<string, string[]> = {}
const dirty = new Set<string>()
const forecastLogged = new Set<string>()
let warned = ''
let tipsLogged = new Set<string>()
let timer: { cancel: () => void } | undefined

const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7)
const logPath = (month: string) => `${folder}/log-${month}-${sessionKey}.jsonl`
const recentMonths = (now: number) => new Set([0, 10, 20, 30, LOG_DAYS].map(d => monthOf(now - d * DAY)))

function log(t: number, entry: Record<string, unknown>) {
  const month = monthOf(t)
  ;(logLines[month] ??= []).push(JSON.stringify({ t, ...entry }))
  dirty.add(month)
}

async function flush($: EngineInterface) {
  for (const month of [...dirty]) {
    dirty.delete(month)
    await $.fs.write(logPath(month), (logLines[month] ?? []).join('\n') + '\n').catch(() => dirty.add(month))
  }
}

async function init($: EngineInterface) {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  base = (configured ?? `${home}/.claude`).replace(/\\/g, '/').replace(/\/$/, '')
  folder = `${base}/limit-metrics`
  sessionKey = (await $.session.id()).slice(0, 8)

  // This session's own lines go back into the buffer, so a reload loses nothing.
  const months = recentMonths(await $.clock.now())
  own = emptyLog()
  for (const month of months) {
    const text = await $.fs.read(logPath(month)).catch(() => '')
    const lines = text.split('\n').filter(Boolean)
    if (lines.length) logLines[month] = lines
    parseLog(text, sessionKey, own)
  }
}

/** Other sessions' logs: their readings and forecasts, re-read when a file changed. */
async function loadLogs($: EngineInterface, now: number) {
  const months = recentMonths(now)
  for (const entry of await $.fs.list(folder).catch(() => [])) {
    const name = logName(entry.name)
    if (!name || name.session === sessionKey || !months.has(name.month) || entry.size > MAX_READ) continue
    const path = `${folder}/${entry.name}`
    const old = others.get(path)
    if (old && old.size === entry.size && old.mtimeMs === entry.mtimeMs) continue
    const text = await $.fs.read(path).catch(() => '')
    others.set(path, { size: entry.size, mtimeMs: entry.mtimeMs, log: parseLog(text, name.session) })
  }
}

function allLogs(now: number): { readings: Reading[]; forecasts: ForecastLog[] } {
  const from = now - LOG_DAYS * DAY
  const logs = [own, ...[...others.values()].map(f => f.log)]
  return {
    readings: dedupeReadings(logs.flatMap(l => l.readings).filter(r => r.t >= from)),
    forecasts: logs.flatMap(l => l.forecasts).filter(f => f.t >= from),
  }
}

/** Keeps each freshly read transcript's days in the monthly rollups, which outlive the transcripts. */
async function writeRollups($: EngineInterface, fresh: Record<string, { project: string; days: Record<string, DayRow> }>) {
  const months: Record<string, Rollup['files']> = {}
  for (const [path, f] of Object.entries(fresh)) {
    for (const [month, days] of Object.entries(byMonth(f.days))) (months[month] ??= {})[path] = { project: f.project, days }
  }
  for (const [month, files] of Object.entries(months)) {
    const path = `${folder}/rollup-${month}.json`
    let cur: Rollup = { version: 1, files: {} }
    if (await $.fs.exists(path).catch(() => true)) {
      // ponytail: one file per month; past 4 MiB (thousands of sessions) it can't be read and stops updating.
      const read = await $.fs.read(path).then(t => JSON.parse(t) as Rollup).catch(() => undefined)
      if (!read) continue // never overwrite what could not be read
      cur = read
    }
    Object.assign(cur.files, files)
    await $.fs.write(path, JSON.stringify(cur)).catch(() => undefined)
  }
}

/**
 * A mod reads at most 4 MiB per file, but long sessions grow far past that
 * (most usage sits in them). Those are streamed through `cat` (`type` on
 * Windows), keeping only the lines the parser reads.
 */
async function readLarge($: EngineInterface, path: string): Promise<string | undefined> {
  const comspec = await $.env.get('ComSpec')
  const argv = comspec ? [comspec, '/d', '/c', 'type', path.replace(/\//g, '\\')] : ['cat', path]
  const keep: string[] = []
  let rest = ''
  try {
    const it = $.process.spawn({ argv })[Symbol.asyncIterator]()
    for (;;) {
      const step = await it.next()
      // A failed read must not be cached as a transcript without usage.
      if (step.done) {
        if (step.value?.code !== 0) return undefined
        break
      }
      if (step.value.stream !== 'stdout') continue
      const lines = (rest + step.value.text).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) if (TRANSCRIPT_LINE.test(line)) keep.push(line)
    }
  } catch {
    return undefined
  }
  if (TRANSCRIPT_LINE.test(rest)) keep.push(rest)
  return keep.join('\n')
}

/** Rebuilds usage from all sessions' transcripts (cached per file), then other sessions' logs. */
async function scan($: EngineInterface) {
  if (scanning || !base) return
  scanning = true
  try {
    const startedAt = await $.clock.now()
    const cachePath = `${folder}/history-cache.json`
    const loaded = await $.fs
      .read(cachePath)
      .then(t => JSON.parse(t) as HistoryCache)
      .catch(() => undefined)
    const cache: HistoryCache = loaded?.version === 4 ? loaded : { version: 4, files: {} }
    const next: HistoryCache = { version: 4, files: {} }
    const buckets: Buckets = {}
    const hits: Hit[] = []
    const fresh: Record<string, { project: string; days: Record<string, DayRow> }> = {}
    let files = 0
    let skipped = 0

    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const entry of await $.fs.list(dir).catch(() => [])) {
        const path = `${dir}/${entry.name}`
        if (entry.kind === 'dir' && depth < 3) await walk(path, depth + 1)
        if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
        if (startedAt - entry.mtimeMs > KEEP_MS) continue
        const old = cache.files[path]
        let cached: FileCache
        if (old && old.size === entry.size && old.mtimeMs === entry.mtimeMs) {
          cached = old
        } else {
          const text = entry.size > MAX_READ ? await readLarge($, path) : await $.fs.read(path).catch(() => '')
          if (text === undefined) {
            skipped += 1
            continue
          }
          const tr = parseTranscript(text)
          const b: Buckets = {}
          for (const turn of tr.turns) addToBuckets(b, turn)
          cached = { size: entry.size, mtimeMs: entry.mtimeMs, buckets: b, hits: tr.hits }
          fresh[path] = { project: projectOf(text, path), days: rollupTranscript(tr) }
        }
        files += 1
        next.files[path] = cached
        mergeBuckets(buckets, cached.buckets)
        hits.push(...cached.hits)
      }
    }
    await walk(`${base}/projects`, 0)
    // Claude Code deletes transcripts after 30 days by default. Their usage and
    // limit hits stay cached until they are older than the look-back, so the
    // forecast can compare with up to 9 past weeks.
    for (const [path, old] of Object.entries(cache.files)) {
      if (next.files[path] || Math.max(...Object.keys(old.buckets).map(Number)) < startedAt - KEEP_MS) continue
      next.files[path] = old
      mergeBuckets(buckets, old.buckets)
      hits.push(...old.hits)
    }

    scanBuckets = buckets
    scanAt = startedAt
    liveTurns = liveTurns.filter(t => t.t > scanAt)
    scanInfo = { files, skipped }
    scanHits = mergeHits(hits)
    await $.fs.write(cachePath, JSON.stringify(next)).catch(() => undefined)
    await writeRollups($, fresh)
    await loadLogs($, startedAt)
  } finally {
    scanning = false
  }
  await recompute($)
}

function allBuckets(): Buckets {
  const b: Buckets = {}
  mergeBuckets(b, scanBuckets)
  for (const t of liveTurns) if (t.t > scanAt) addToBuckets(b, t)
  return b
}

/** Tuned settings per window: the replay is costly, so it runs at most once an hour. */
const tuned = new Map<string, { key: string; t: Tuning }>()
function tuningFor(kind: string, b: Buckets, now: number, horizon: number, w: Record<Family, number>): Tuning {
  const key = `${Math.floor(now / HOUR)}|${Math.round(horizon / HOUR)}|${w.opus}|${w.fable}`
  const cur = tuned.get(kind)
  if (cur?.key === key) return cur.t
  const t = tune(b, kind, now, horizon)
  tuned.set(kind, { key, t })
  return t
}

async function readShared($: EngineInterface): Promise<Shared> {
  const v = (await $.store.get(SHARED).catch(() => undefined)) as Partial<Shared> | undefined
  return { ...emptyShared(), ...(v ?? {}) }
}

async function writeShared($: EngineInterface, next: Shared, prev: Shared) {
  if (JSON.stringify(next) !== JSON.stringify(prev)) await $.store.set(SHARED, next).catch(() => undefined)
}

/** The context window as last measured; redraws the line only when it moved. */
async function setCtx($: EngineInterface, c: { tokens?: number; window?: number }) {
  if (c.tokens === undefined || c.window === undefined) return
  const cur = await read($, ctx)
  if (cur && cur.tokens === c.tokens && cur.window === c.window) return
  const tokens = c.tokens
  const window = c.window
  await update($, ctx, () => ({ tokens, window }))
}

/** A window's reading, kept when it moved: for this session's log and for the calibration. */
function noteReading(now: number, kind: string, p: number, resetsAt?: string) {
  const r = resetsAt ? normReset(resetsAt) : undefined
  const last = lastLive[kind]
  if (last && last.p === p && last.r === r) return
  const reading: Reading = { t: now, kind, p, r }
  lastLive[kind] = reading
  own.readings.push(reading)
  log(now, { k: 'r', w: kind, p, r })
}

/**
 * Each model's own weekly window. Claude Code hands mods the shared windows
 * only, so these come from the usage endpoint, with the session's own login:
 * the engine sets the credential, the mod never sees it. One session asks for
 * all of them, when the last answer is 5 minutes old and a response has come
 * in since, or when it has not looked yet.
 */
async function scopedWindows($: EngineInterface, now: number): Promise<Limit[]> {
  if (!modelLimits) return []
  let cur = (await $.store.get(SCOPED).catch(() => undefined)) as Scoped | undefined
  const moved = !scopedSeen || !cur || (reportedAt ?? 0) > cur.at
  scopedSeen = true
  if (moved && now >= (cur?.next ?? 0)) {
    // Claimed before asking, so sessions measuring at the same moment do not all ask;
    // the claim is the back-off too, should the answer not come.
    cur = { at: cur?.at ?? 0, limits: cur?.limits ?? [], next: now + SCOPED_BACKOFF_MS }
    await $.store.set(SCOPED, cur).catch(() => undefined)
    try {
      const auth = await $.session.authorize()
      const res = auth?.kind === 'bearer' ? await $.http.fetch(USAGE_URL, { auth: auth.handle }) : undefined
      if (res?.ok) {
        cur = { at: now, next: now + SCOPED_MS, limits: scopedLimits(JSON.parse(res.text)) }
        for (const l of cur.limits) noteReading(now, l.kind, l.percentUsed, l.resetsAt)
        await $.store.set(SCOPED, cur).catch(() => undefined)
      }
    } catch {
      // No login, no network, or non-essential traffic turned off: what it had stays until it resets.
    }
  }
  return (cur?.limits ?? []).filter(l => !l.resetsAt || Date.parse(l.resetsAt) > now)
}

async function recompute($: EngineInterface) {
  const now = await $.clock.now()
  reportedAt ??= own.readings.reduce<number | undefined>((a, r) => Math.max(a ?? 0, r.t), undefined)
  const usage = await $.session.usage().catch(() => undefined)
  if (usage) await setCtx($, usage.context)
  const allLimits: Limit[] = [...(usage?.rateLimits ?? []), ...(await scopedWindows($, now))]
  const limits = allLimits.filter(l => l.kind !== 'spend_limit')
  const kinds = [...new Set([...KINDS, ...limits.map(l => l.kind)])]
  const shared = await readShared($)
  const raw = allBuckets()
  const logs = allLogs(now)
  // Past limit hits are exact readings too: 0% at the window's start, 100% when refused.
  const readings = dedupeReadings([...logs.readings, ...hitReadings(scanHits), ...startReadings(logs.readings)])
  const logged = logs.forecasts
  // Once a family's check shows it clearly costs more (or less) than assumed, count it so.
  const rawIndex = usageIndex(raw)
  const recent = rawIndex(now - LOOKBACK_DAYS * DAY, now)
  const families = FAMILIES.filter(f => recent[FAMILY_CELL[f]] > 0)
  const checks: Partial<Record<Family, ReturnType<typeof weightCheck>>> = {}
  for (const f of families) checks[f] = weightCheck(readings, rawIndex, now, f)
  const weights: Record<Family, number> = { opus: familyWeight(checks.opus), fable: familyWeight(checks.fable) }
  const buckets = reweight(raw, weights)
  const between = usageIndex(buckets)
  const prof = profile(buckets, now)
  // A model's own window counts that model's usage alone.
  const scopes = new Map<string, { buckets: Buckets; between: Between; prof: Profile }>()
  const usageOf = (kind: string) => {
    const scope = scopeOf(kind)
    if (scope === undefined) return { buckets, between, prof }
    let u = scopes.get(scope)
    if (!u) {
      const b = familyBuckets(buckets, family(scope))
      u = { buckets: b, between: usageIndex(b), prof: profile(b, now) }
      scopes.set(scope, u)
    }
    return u
  }
  const cal: Record<string, Calib> = {}
  const quality: Record<string, Quality> = {}
  const corr: Record<string, number> = {}
  for (const kind of kinds) {
    cal[kind] = calibrate(readings, usageOf(kind).between, kind, now)
    // Scored first: how far past forecasts ran off at percent level scales k.
    quality[kind] = evaluate(logged, readings, kind, now)
    corr[kind] = correction(quality[kind]!)
  }

  const tunings: Record<string, Tuning> = {}
  const forecasts: Forecast[] = limits.map(l => {
    const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : undefined
    const u = usageOf(l.kind)
    const t = tuningFor(l.kind, u.buckets, now, resetsAt === undefined ? 0 : resetsAt - now, weights)
    tunings[l.kind] = t
    return forecast({
      kind: l.kind,
      p: l.percentUsed,
      resetsAt,
      r: l.resetsAt ? normReset(l.resetsAt) : undefined,
      now,
      cal: cal[l.kind],
      between: u.between,
      readings,
      prof: t.halfLife === u.prof.halfLife ? u.prof : profile(u.buckets, now, 8, t.halfLife),
      tune: t,
      prev: shared.verdicts[l.kind],
      correction: corr[l.kind],
      share: l.share,
    })
  })

  // One forecast per window and hour is kept, to be scored after the reset.
  for (const [i, f] of forecasts.entries()) {
    const key = `${f.kind}|${Math.floor(now / HOUR)}`
    const reset = limits[i]?.resetsAt
    const entry = toLog(f, now, reset ? normReset(reset) : undefined)
    if (!entry || forecastLogged.has(key)) continue
    forecastLogged.add(key)
    own.forecasts.push(entry)
    log(now, forecastEntry(entry))
  }

  const overall = worst(forecasts.map(f => f.verdict))
  const worstOne = forecasts.find(f => f.verdict === overall)
  const warningKey = `${overall}:${worstOne?.kind ?? ''}`
  const tips = suggestions({ forecasts, between, now, context: (await read($, ctx))?.tokens })
  const next: Shared = {
    ...shared,
    key: overall === 'ok' ? '' : warningKey,
    overall,
    verdicts: Object.fromEntries(forecasts.map(f => [f.kind, f.verdict])),
    marks: {},
  }
  if (overall === 'ok') warned = ''
  else {
    if (warned !== warningKey) {
      warned = warningKey
      tipsLogged = new Set()
    }
    // The first session to see a warning logs it; each session logs the tips it shows.
    if (shared.key !== warningKey) log(now, { k: 'e', e: 'warn', v: overall, w: worstOne?.kind })
    for (const tip of tips.slice(0, 2)) {
      if (tipsLogged.has(tip.id)) continue
      tipsLogged.add(tip.id)
      log(now, { k: 'e', e: 'tip', id: tip.id })
    }
  }

  const week = limits.find(l => l.kind === 'seven_day')
  const kWeek = cal.seven_day?.k
  const reg = regularity(between, now, prof.since)
  const nextView: View = {
    updatedAt: now,
    ...(reportedAt !== undefined ? { reportedAt } : {}),
    overall,
    warningKey,
    forecasts,
    tips,
    learned: {
      calib: kinds.map(kind => ({ label: labelOf(kind), ...cal[kind]!, kind })),
      weights: families.map(f => ({ family: f, label: FAMILY_LABEL[f], ...(checks[f] ? { ...checks[f]!, applied: weights[f] !== 1 } : {}) })),
      tuning: kinds.filter(kind => tunings[kind]).map(kind => ({ kind, label: labelOf(kind), ...tunings[kind]! })),
      ...(reg ? { regularity: reg } : {}),
    },
    quality: kinds.map(kind => ({ label: labelOf(kind), ...quality[kind]!, correction: corr[kind]! })),
    history: {
      scanning,
      days: Math.floor(prof.days),
      files: scanInfo.files,
      skipped: scanInfo.skipped,
      busiest: prof.days >= 7 ? busiestDays(prof.perHour) : [],
      pastWeeks: week?.resetsAt && kWeek !== undefined ? pastWeeks(between, Date.parse(week.resetsAt), kWeek, prof.since) : [],
      hits: hitSummary(limitHits(readings.filter(r => r.p >= 99.5), scanHits)),
    },
    folder,
  }
  await update($, view, () => nextView)
  // A hide in any session holds in all of them.
  if ((await read($, hiddenKey)) !== shared.hidden) await update($, hiddenKey, () => shared.hidden)

  // Speak up only when things get worse, or a threshold is crossed, and once across sessions.
  if (toasts && isWorse(overall, shared.overall) && worstOne) $.ui.toast(worstOne.headline, { timeoutMs: 8000 })
  for (const l of allLimits) {
    const r = l.resetsAt ?? ''
    const was = shared.marks[l.kind]
    const m = { r, m: was && was.r === r ? [...was.m] : [] }
    for (const mark of [80, 90]) {
      if (l.percentUsed >= mark && !m.m.includes(mark)) {
        m.m.push(mark)
        if (toasts) $.ui.toast(`${shortOf(l.kind)} limit at ${fmtPct(l.percentUsed)}`)
      }
    }
    next.marks[l.kind] = m
  }
  await writeShared($, next, shared)
}

/** Writes the export folder from every log and rollup there is. */
async function exportAll($: EngineInterface): Promise<string> {
  await flush($)
  const now = await $.clock.now()
  const all = emptyLog()
  const rollups: Rollup[] = []
  let skipped = 0
  for (const entry of await $.fs.list(folder).catch(() => [])) {
    const name = logName(entry.name)
    const isRollup = /^rollup-\d{4}-\d{2}\.json$/.test(entry.name)
    if (!name && !isRollup) continue
    if (entry.size > MAX_READ) {
      skipped += 1
      continue
    }
    const text = await $.fs.read(`${folder}/${entry.name}`).catch(() => '')
    if (name) parseLog(text, name.session, all)
    else {
      try {
        rollups.push(JSON.parse(text) as Rollup)
      } catch {
        skipped += 1
      }
    }
  }
  all.readings = dedupeReadings(all.readings)
  const out = `${folder}/export`
  for (const [file, text] of Object.entries(buildExport({ log: all, rollups, now }))) await $.fs.write(`${out}/${file}`, text)
  log(now, { k: 'e', e: 'export' })
  return `Exported to ${out}${skipped ? ` (${skipped} files skipped: over 4 MiB or unreadable)` : ''}.`
}

const verdictColor = (verdict: Verdict) => (verdict === 'ok' ? 'success' : verdict === 'slow' ? 'warning' : 'error')
const TONE = { good: 'success', warn: 'warning', bad: 'error' } as const

type TextStyle = { color?: string; dimColor?: boolean; bold?: boolean }

/** How each part of a bar is drawn, in the window's verdict color. */
const barTint = (verdict: Verdict): Record<BarPart['kind'], TextStyle> => ({
  used: { color: verdictColor(verdict) },
  likely: { color: verdictColor(verdict), dimColor: true },
  range: { color: 'subtle' },
  free: { color: 'subtle', dimColor: true },
  limit: { bold: true },
})

/** How each piece of the limits line is drawn: the forecast in its tone, the verdict in its color. */
function lineStyle(p: LinePart, verdict: Verdict): TextStyle {
  switch (p.kind) {
    case 'dim':
      return { dimColor: true }
    case 'pct':
      return { bold: true }
    case 'ahead':
      return p.tone ? { color: TONE[p.tone], bold: p.tone !== 'good' } : { dimColor: true }
    case 'risk':
      return { dimColor: p.text === '–' }
    case 'dot':
      return { color: verdictColor(verdict) }
    case 'verdict':
      return { color: verdictColor(verdict), bold: true }
    default:
      return {}
  }
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Usage limits' })

export const register: Register = (on, options) => {
  lineMode = options.line === 'compact' ? 'compact' : options.line === 'off' ? 'off' : 'full'
  toasts = options.toasts !== false
  modelLimits = options.modelLimits !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'limits-forecast', description: 'Usage limits: forecast, history and suggestions', argumentHint: 'text | export' })
    await init($)
    // The limits line is drawn in the band above the prompt now.
    $.ui.status(undefined)
    timer?.cancel()
    // Every few minutes: write the log, pick up other sessions' usage, recompute.
    timer = $.clock.every(FLUSH_MS, () => {
      void flush($)
        .then(() => scan($))
        .catch(() => undefined)
    })
    $.clock.after(1000, () => {
      void scan($).catch(() => undefined)
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    await flush($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const u = e.usage
    const now = await $.clock.now()
    const sub = e.agentId !== undefined
    const entry: Record<string, unknown> = { k: 't', d: e.durationMs, s: sub ? 1 : 0 }
    if (e.isAborted) entry.a = 1
    const c = sub ? null : await read($, ctx)
    if (c) entry.x = c.tokens
    if (u) {
      const turn: Turn = {
        t: now,
        model: u.model,
        in: u.input_tokens,
        cw: u.cache_creation_input_tokens,
        cr: u.cache_read_input_tokens,
        out: u.output_tokens,
        sub,
      }
      liveTurns.push(turn)
      Object.assign(entry, { m: turn.model, i: turn.in, cw: turn.cw, cr: turn.cr, o: turn.out })
    }
    log(now, entry)
    return result
  })

  on('session.compact', async ($, e, next) => {
    const before = (await read($, ctx))?.tokens
    const result = await next(e)
    log(await $.clock.now(), { k: 'e', e: 'compact', ...(before !== undefined ? { x: before } : {}) })
    return result
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.changed.includes('context')) await setCtx($, e.context)
    if (e.rateLimits.length) reportedAt = now
    for (const l of e.rateLimits) noteReading(now, l.kind, l.percentUsed, l.resetsAt)
    if (e.changed.includes('rateLimits')) await recompute($)
    else if (e.rateLimits.length) {
      // Same percent, fresh report: only the time moves.
      await update($, view, v => (v ? { ...v, reportedAt: now } : v))
    }
    return next(e)
  })

  on('command.run', { command: 'limits-forecast' }, async ($, e) => {
    if (e.args.trim() === 'export') return { text: await exportAll($) }
    const asText = e.args.trim() === 'text' || !drawsUi
    const opened = asText ? undefined : await openPane($)
    log(await $.clock.now(), { k: 'e', e: asText ? 'text' : 'pane' })
    const v = await read($, view)
    if (!scanning && (v === null || (await $.clock.now()) - scanAt > 30 * 60_000)) {
      $.clock.after(0, () => {
        void scan($).catch(() => undefined)
      })
    } else {
      await recompute($)
    }
    // Where no pane shows, the same report as text.
    if (opened?.isPlaced !== false && !asText) return { text: 'Usage limits pane opened.' }
    return { text: reportText(await read($, view)) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    drawsUi = true
    if (lineMode === 'off' || e.props.hasSurvey) return next(e)
    const v = await read($, view)
    const c = await read($, ctx)
    const { Box, Button, Text } = $.ui.resolve(e)
    const ctxText = c && c.window > 0 ? `ctx ${kTokens(c.tokens)}/${kTokens(c.window)} ${Math.round((c.tokens / c.window) * 100)}%` : undefined
    if (!v || v.forecasts.length === 0) return ctxText && lineMode === 'full' ? <Text dimColor>{ctxText}</Text> : next(e)
    // One line, each verdict in its own color, the warning only under pressure.
    // What does not fit the terminal goes, the small bars first.
    const o = fitLine(v.forecasts, e.props.bodyColumns, lineMode === 'compact', v.reportedAt, ctxText)
    const line = (
      <Box flexDirection="row">
        {v.forecasts.map((f, i) => (
          <Box flexDirection="row" flexShrink={0}>
            {i > 0 && <Text dimColor>{o.sep}</Text>}
            {lineParts(f, o).flatMap(p =>
              p.kind === 'bar'
                ? rangeBar(f, LINE_BAR).map(part => <Text {...barTint(f.verdict)[part.kind]}>{part.text}</Text>)
                : [<Text {...lineStyle(p, f.verdict)}>{p.text}</Text>],
            )}
          </Box>
        ))}
        {o.time && v.reportedAt !== undefined && <Text dimColor>{`   · ${hhmm(v.reportedAt)}`}</Text>}
        {o.ctx && ctxText && <Text dimColor>{`   · ${ctxText}`}</Text>}
      </Box>
    )
    if (v.overall === 'ok' || (await read($, hiddenKey)) === v.warningKey) return line
    const head = v.forecasts.find(f => f.verdict === v.overall)
    return (
      <Box flexDirection="column">
        {line}
        <Text bold color={v.overall === 'hold' ? 'error' : 'warning'}>
          {v.overall === 'hold' ? 'Hold on: ' : 'Slow down: '}
          {head?.headline ?? ''}
        </Text>
        {v.tips.slice(0, 2).map(tip => (
          <Text dimColor>• {tip.text}</Text>
        ))}
        <Box flexDirection="row">
          <Button key="details" label="Details" onPress={() => openPane($)} />
          <Text> </Text>
          <Button
            key="hide"
            label="Hide"
            onPress={async () => {
              log(await $.clock.now(), { k: 'e', e: 'hide', key: v.warningKey })
              await update($, hiddenKey, () => v.warningKey)
              const s = await readShared($)
              await writeShared($, { ...s, hidden: v.warningKey }, s)
            }}
          />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    drawsUi = true
    const { Box, Text } = $.ui.resolve(e)
    const v = await read($, view)
    if (!v) return <Text dimColor>Collecting data…</Text>
    const row = (r: Row) => (
      <Box flexDirection="row">
        <Box width={14} flexShrink={0}>
          <Text dimColor>{`  ${r.label}`}</Text>
        </Box>
        <Text dimColor={r.dim}>{r.value}</Text>
      </Box>
    )
    const rep = report(v)
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text dimColor>{rep.note}</Text>
        </Box>
        {v.forecasts.map(f => {
          const c = verdictColor(f.verdict)
          const tint = barTint(f.verdict)
          return (
            <Box flexDirection="column" marginBottom={1}>
              <Box flexDirection="row">
                <Box width={14} flexShrink={0}>
                  <Text bold>{f.label}</Text>
                </Box>
                <Text bold color={c}>{VERDICT_TEXT[f.verdict]}</Text>
              </Box>
              <Box flexDirection="row">
                <Box width={14} flexShrink={0}>
                  <Text> </Text>
                </Box>
                {rangeBar(f).map(part => (
                  <Text {...tint[part.kind]}>{part.text}</Text>
                ))}
              </Box>
              {forecastRows(f, v).map(row)}
            </Box>
          )
        })}
        {v.forecasts.length > 0 && (
          <Box marginBottom={1}>
            <Text dimColor>{LEGEND}</Text>
          </Box>
        )}

        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Suggestions</Text>
          {v.tips.length === 0 ? <Text dimColor>  – nothing to change right now</Text> : v.tips.map(tip => <Text>{`  • ${tip.text}`}</Text>)}
        </Box>

        {rep.sections.map(sec => (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>{sec.title}</Text>
            {sec.rows.map(row)}
          </Box>
        ))}
        <Text dimColor>{rep.footer}</Text>
      </Box>
    )
  })
}
