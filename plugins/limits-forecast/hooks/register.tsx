import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { View } from '../types'
import {
  addToBuckets,
  busiestDays,
  calibrate,
  DAY,
  dedupeReadings,
  dur,
  evaluate,
  fmtPct,
  fmtRange,
  forecast,
  HOUR,
  isWorse,
  LABEL,
  mergeBuckets,
  hitReadings,
  mergeHits,
  normReset,
  parseTranscript,
  TRANSCRIPT_LINE,
  pastWeeks,
  rangeBar,
  profile,
  regularity,
  SHORT,
  hhmm,
  statusParts,
  statusText,
  suggestions,
  toLog,
  usageIndex,
  VERDICT_TEXT,
  weightCheck,
  worst,
} from './model'
import type { BarPart, Buckets, Calib, Forecast, ForecastLog, Hit, Reading, Turn, Verdict } from './model'
import { blockedMs, buildExport, byMonth, emptyLog, forecastEntry, limitHits, logName, parseLog, projectOf, rollupTranscript } from './retro'
import type { DayRow, Log, Rollup } from './retro'

const PANE = 'limits'
const view = atom({ plugin: 'limits-forecast', key: 'view' } as const, null)
const hiddenKey = atom({ plugin: 'limits-forecast', key: 'hiddenKey' } as const, '')

const MAX_READ = 4 * 1024 * 1024
const FLUSH_MS = 5 * 60_000
const KEEP_MS = 10 * 7 * DAY
/** Readings and forecasts of all sessions are loaded this far back. */
const LOG_DAYS = 40
const KINDS = ['five_hour', 'seven_day']

type FileCache = { size: number; mtimeMs: number; buckets: Buckets; hits: Hit[] }
type HistoryCache = { version: 3; files: Record<string, FileCache> }
type LogFile = { size: number; mtimeMs: number; log: Log }

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
let context: number | undefined
/** When Claude Code last reported the limits: they come with responses only. */
let reportedAt: number | undefined
const lastLive: Record<string, Reading> = {}
const logLines: Record<string, string[]> = {}
const dirty = new Set<string>()
const notified = new Set<string>()
const forecastLogged = new Set<string>()
let prevOverall: Verdict = 'ok'
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
    const cache: HistoryCache = loaded?.version === 3 ? loaded : { version: 3, files: {} }
    const next: HistoryCache = { version: 3, files: {} }
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

async function recompute($: EngineInterface) {
  const now = await $.clock.now()
  reportedAt ??= own.readings.reduce<number | undefined>((a, r) => Math.max(a ?? 0, r.t), undefined)
  const usage = await $.session.usage().catch(() => undefined)
  const allLimits = usage?.rateLimits ?? []
  const limits = allLimits.filter(l => KINDS.includes(l.kind))
  context = usage?.context.tokens ?? context
  const buckets = allBuckets()
  const between = usageIndex(buckets)
  const prof = profile(buckets, now)
  const logs = allLogs(now)
  // Past limit hits are exact readings too: 0% at the window's start, 100% when refused.
  const readings = dedupeReadings([...logs.readings, ...hitReadings(scanHits)])
  const logged = logs.forecasts
  const cal: Record<string, Calib> = Object.fromEntries(KINDS.map(kind => [kind, calibrate(readings, between, kind, now)]))

  const forecasts: Forecast[] = limits.map(l =>
    forecast({
      kind: l.kind,
      p: l.percentUsed,
      resetsAt: l.resetsAt ? Date.parse(l.resetsAt) : undefined,
      r: l.resetsAt ? normReset(l.resetsAt) : undefined,
      now,
      cal: cal[l.kind],
      between,
      readings,
      prof,
    }),
  )

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
  const tips = suggestions({ forecasts, between, now, context })
  if (overall === 'ok') warned = ''
  else {
    if (warned !== warningKey) {
      warned = warningKey
      tipsLogged = new Set()
      log(now, { k: 'e', e: 'warn', v: overall, w: worstOne?.kind })
    }
    for (const tip of tips.slice(0, 2)) {
      if (tipsLogged.has(tip.id)) continue
      tipsLogged.add(tip.id)
      log(now, { k: 'e', e: 'tip', id: tip.id })
    }
  }

  const week = limits.find(l => l.kind === 'seven_day')
  const kWeek = cal.seven_day?.k
  const check = weightCheck(readings, between, now)
  const reg = regularity(between, now, prof.since)
  const next: View = {
    updatedAt: now,
    ...(reportedAt !== undefined ? { reportedAt } : {}),
    overall,
    warningKey,
    forecasts,
    tips,
    learned: {
      calib: KINDS.map(kind => ({ label: LABEL[kind] ?? kind, ...cal[kind]!, kind })),
      ...(check ? { opusCheck: check } : {}),
      ...(reg ? { regularity: reg } : {}),
    },
    quality: KINDS.map(kind => ({ label: LABEL[kind] ?? kind, ...evaluate(logged, readings, kind, now) })),
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
  await update($, view, () => next)


  // Speak up only when things get worse, or a threshold is crossed.
  if (isWorse(overall, prevOverall) && worstOne) $.ui.toast(worstOne.headline, { timeoutMs: 8000 })
  prevOverall = overall
  for (const l of allLimits) {
    for (const mark of [80, 90]) {
      const key = `${l.kind}:${l.resetsAt}:${mark}`
      if (l.percentUsed >= mark && !notified.has(key)) {
        notified.add(key)
        $.ui.toast(`${SHORT[l.kind] ?? l.kind} limit at ${fmtPct(l.percentUsed)}`)
      }
    }
  }
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

/** How each part of a bar is drawn, in the window's verdict color. */
const barTint = (verdict: Verdict): Record<BarPart['kind'], { color?: string; dimColor?: boolean; bold?: boolean }> => ({
  used: { color: verdictColor(verdict) },
  likely: { color: verdictColor(verdict), dimColor: true },
  range: { color: 'subtle' },
  free: { color: 'subtle', dimColor: true },
  limit: { bold: true },
})

/** Cells of the small bar in the limits line, left out when the line would not fit. */
const LINE_BAR = 10

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Usage limits' })

const pct1 = (x: number) => `${Math.round(x * 100)}%`
const num = (x: number, d = 1) => x.toFixed(d)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'limits', description: 'Usage limits: forecast, history and suggestions ("/limits export" writes CSVs)' })
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
    if (!sub && context !== undefined) entry.x = context
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
    const before = context
    const result = await next(e)
    log(await $.clock.now(), { k: 'e', e: 'compact', ...(before !== undefined ? { x: before } : {}) })
    return result
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.context.tokens !== undefined) context = e.context.tokens
    if (e.rateLimits.length) reportedAt = now
    for (const l of e.rateLimits) {
      const r = l.resetsAt ? normReset(l.resetsAt) : undefined
      const reading: Reading = { t: now, kind: l.kind, p: l.percentUsed, r }
      const last = lastLive[l.kind]
      if (last && last.p === reading.p && last.r === reading.r) continue
      lastLive[l.kind] = reading
      own.readings.push(reading)
      log(now, { k: 'r', w: l.kind, p: l.percentUsed, r })
    }
    if (e.changed.includes('rateLimits')) await recompute($)
    else if (e.rateLimits.length) {
      // Same percent, fresh report: only the time moves.
      await update($, view, v => (v ? { ...v, reportedAt: now } : v))
    }
    return next(e)
  })

  on('command.run', { command: 'limits' }, async ($, e) => {
    if (e.args.trim() === 'export') return { text: await exportAll($) }
    await openPane($)
    log(await $.clock.now(), { k: 'e', e: 'pane' })
    const v = await read($, view)
    if (!scanning && (v === null || (await $.clock.now()) - scanAt > 30 * 60_000)) {
      $.clock.after(0, () => {
        void scan($).catch(() => undefined)
      })
    } else {
      await recompute($)
    }
    return { text: 'Usage limits pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (e.props.hasSurvey || !v || v.forecasts.length === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    // Always one line, each verdict in its own color; the warning only under pressure.
    // The small bars go when the line would not fit.
    const plain = statusText(v.forecasts, v.reportedAt) ?? ''
    const bars = plain.length + v.forecasts.length * (LINE_BAR + 2) <= e.props.bodyColumns
    const line = (
      <Box flexDirection="row">
        {v.forecasts.map((f, i) => {
          const s = statusParts(f)
          return (
            <Box flexDirection="row" flexShrink={0}>
              {i > 0 && <Text dimColor>{'   │   '}</Text>}
              <Text dimColor>{`${s.name} `}</Text>
              {bars && rangeBar(f, LINE_BAR).map(part => <Text {...barTint(f.verdict)[part.kind]}>{part.text}</Text>)}
              {bars && <Text> </Text>}
              <Text bold>{s.pct}</Text>
              <Text dimColor>{' ↻ '}</Text>
              <Text>{s.reset}</Text>
              <Text dimColor>{' → '}</Text>
              <Text bold={s.tone !== undefined && s.tone !== 'good'} {...(s.tone ? { color: TONE[s.tone] } : { dimColor: true })}>{s.ahead}</Text>
              {s.range && <Text dimColor>{` (${s.range})`}</Text>}
              <Text dimColor>{' risk '}</Text>
              <Text dimColor={s.risk === '–'}>{s.risk}</Text>
              <Text color={verdictColor(f.verdict)}>{' ● '}</Text>
              <Text bold color={verdictColor(f.verdict)}>{s.verdict}</Text>
            </Box>
          )
        })}
        {v.reportedAt !== undefined && <Text dimColor>{`   · ${hhmm(v.reportedAt)}`}</Text>}
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
            }}
          />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const v = await read($, view)
    if (!v) return <Text dimColor>Collecting data…</Text>
    const hist = v.history
    const row = (label: string, value: string, dim = false) => (
      <Box flexDirection="row">
        <Box width={14} flexShrink={0}>
          <Text dimColor>{`  ${label}`}</Text>
        </Box>
        <Text dimColor={dim}>{value}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {v.forecasts.length > 0 && (
          <Box marginBottom={1}>
            <Text dimColor>
              {`As of ${v.reportedAt !== undefined ? clockTime(v.reportedAt, false) : '–'} · updates with every response`}
            </Text>
          </Box>
        )}
        {v.forecasts.length === 0 && (
          <Text dimColor>No limit reading yet: it arrives with the next response (subscription plans only).</Text>
        )}
        {v.forecasts.map(f => {
          const c = verdictColor(f.verdict)
          const tint = barTint(f.verdict)
          const week = f.kind === 'seven_day'
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
              {row('used', `${fmtPct(f.p)} now`)}
              {row(
                'resets',
                f.msToReset !== undefined ? `in ${dur(f.msToReset)} · ${clockTime(v.updatedAt + f.msToReset, week)}` : '–',
                f.msToReset === undefined,
              )}
              {row(
                'at reset',
                f.projected === undefined
                  ? '– learning how your tokens map to percent'
                  : `~${fmtPct(f.projected)}` +
                      (f.lo !== undefined && f.hi !== undefined
                        ? `  ·  80% range ${fmtRange(f.lo, f.hi)}  (from ${f.samples} past ${f.sampleUnit})`
                        : `  ·  range needs 3 comparable past ${week ? 'weeks' : 'days'}`),
                f.projected === undefined,
              )}
              {row('risk', f.risk !== undefined ? `${pct1(f.risk)} chance to run out before the reset` : '– comes with the range', f.risk === undefined)}
              {row('speed', f.rate !== undefined ? `${f.rate.toFixed(1)}%/h over ${f.rateBasis}` : `– ${f.rateBasis}`, f.rate === undefined)}
              {row(
                'even pace',
                f.pace !== undefined ? `${fmtPct(f.pace)} by now · you are ${f.p <= f.pace ? 'under' : 'over'} by ${Math.round(Math.abs(f.p - f.pace))}` : '–',
                f.pace === undefined,
              )}
              {week && row('per day', f.perDayLeft !== undefined ? `~${fmtPct(f.perDayLeft)} a day left until the reset` : '–', f.perDayLeft === undefined)}
            </Box>
          )
        })}
        {v.forecasts.length > 0 && (
          <Box marginBottom={1}>
            <Text dimColor>{'█ used   ▓ forecast by the reset   ▒ 80% range above it   │ the limit (100%)'}</Text>
          </Box>
        )}

        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Suggestions</Text>
          {v.tips.length === 0 ? <Text dimColor>  – nothing to change right now</Text> : v.tips.map(tip => <Text>{`  • ${tip.text}`}</Text>)}
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Learning</Text>
          {v.learned.calib.map(c =>
            row(
              c.label,
              c.k === undefined
                ? `learning tokens → %: ${String(Math.round(Math.min(c.points, 3) * 10) / 10)} of 3 points seen`
                : c.se !== undefined
                  ? `tokens → % learned, ±${pct1(c.se / c.k)} (${c.n} stretches)`
                  : `tokens → % learned (${c.n} stretches; error estimate from 3)`,
              c.k === undefined,
            ),
          )}
          {row('Opus cost', opusText(v.learned.opusCheck), !v.learned.opusCheck)}
          {row(
            'your weeks',
            v.learned.regularity
              ? `vary by ±${pct1(v.learned.regularity.cv)} from week to week (${v.learned.regularity.weeks} weeks)`
              : '– needs 2 full weeks',
            !v.learned.regularity,
          )}
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Forecast quality · last 4 weeks</Text>
          {v.quality.map(q => row(q.label, qualityText(q), q.n < 3))}
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Text bold>History</Text>
          {row(
            'read',
            hist.scanning
              ? 'reading past sessions…'
              : `${hist.days} days from ${hist.files} transcripts${hist.skipped ? ` (${hist.skipped} could not be read)` : ''}`,
          )}
          {row(
            'limit hits',
            hist.hits.count ? hitText(hist.hits) : '– none in your history',
            !hist.hits.count,
          )}
          {row('busiest', hist.busiest.length ? hist.busiest.join(', ') : '– needs a week', !hist.busiest.length)}
          {row(
            'past weeks',
            hist.pastWeeks.length ? `${hist.pastWeeks.map(p => fmtPct(p)).join(' · ')}  (latest first, estimated)` : '–',
            !hist.pastWeeks.length,
          )}
        </Box>
        <Text dimColor>{`Data: ${v.folder}  ·  /limits export writes CSVs for a retrospective`}</Text>
      </Box>
    )
  })
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function clockTime(t: number, withDay: boolean) {
  const d = new Date(t)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return withDay ? `${DAYS[d.getDay()]} ${hm}` : hm
}

function opusText(c: View['learned']['opusCheck']): string {
  if (!c) return '– needs more mixed Opus and other use to check'
  const x = `×${num(c.ratio, 2)} ± ${num(c.se, 2)}`
  if (Math.abs(c.ratio - 1) <= 2 * c.se) return `weighted as assumed (${x})`
  return `${c.ratio > 1 ? 'costs more' : 'costs less'} of your limit than assumed (${x})`
}

function qualityText(q: View['quality'][number]): string {
  if (q.n < 3) return `– ${q.n} forecasts checked so far, scores after 3 resets`
  const parts = [`off by ±${num(q.mae ?? 0)} pts`]
  if (q.bias !== undefined && Math.abs(q.bias) >= 3) parts.push(`tends to run ${q.bias > 0 ? 'high' : 'low'}`)
  if (q.coverage !== undefined) parts.push(`range held ${pct1(q.coverage)} (aim 80%)`)
  if (q.skill !== undefined) parts.push(`${pct1(Math.abs(q.skill))} ${q.skill >= 0 ? 'better' : 'worse'} than "speed stays the same"`)
  if (q.brier !== undefined) parts.push(`risk score ${num(q.brier, 2)} (0 best, 0.25 coin toss)`)
  parts.push(`${q.n} checked`)
  return parts.join(' · ')
}

function hitSummary(hits: Hit[]): View['history']['hits'] {
  const n = (kind: string) => hits.filter(h => h.kind === kind).length
  return {
    count: hits.length,
    fiveHour: n('five_hour'),
    weekly: n('seven_day'),
    blockedHours: hits.reduce((a, h) => a + blockedMs(h), 0) / HOUR,
    ...(hits.length ? { last: hits[hits.length - 1]!.t } : {}),
  }
}

function hitText(h: View['history']['hits']): string {
  const kinds = [h.fiveHour ? `${h.fiveHour}× 5-hour` : '', h.weekly ? `${h.weekly}× weekly` : ''].filter(Boolean).join(', ')
  const last = h.last !== undefined ? ` · last ${clockTime(h.last, true)} ${new Date(h.last).getDate()}.${new Date(h.last).getMonth() + 1}.` : ''
  return `${kinds} · ${num(h.blockedHours)} h blocked${last}`
}
