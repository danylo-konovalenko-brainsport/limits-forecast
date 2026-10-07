import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { View } from '../types'
import {
  addCalib,
  addToBuckets,
  bar,
  busiestDays,
  dur,
  fmtPct,
  forecast,
  isWorse,
  mergeBuckets,
  parseTranscript,
  pastWeeks,
  profile,
  ratio,
  suggestions,
  units,
  VERDICT_TEXT,
  worst,
} from './model'
import type { Calib, Forecast, HourBuckets, Reading, Turn, Verdict } from './model'

const PANE = 'limits'
const view = atom({ plugin: 'limits', key: 'view' } as const, null)
const hiddenKey = atom({ plugin: 'limits', key: 'hiddenKey' } as const, '')

const MAX_READ = 4 * 1024 * 1024
const FLUSH_MS = 5 * 60_000
const KEEP_MS = 10 * 7 * 24 * 3_600_000
const SHORT: Record<string, string> = { five_hour: '5h', seven_day: 'wk' }

type FileCache = { size: number; mtimeMs: number; hours: HourBuckets }
type HistoryCache = { version: 1; files: Record<string, FileCache> }

// This process's own data; values the UI reads live in atoms.
let base = ''
let folder = ''
let sessionKey = ''
let calib: Calib = {}
let readings: Reading[] = []
let liveTurns: Turn[] = []
let scanBuckets: HourBuckets = {}
let scanAt = 0
let scanning = false
let scanInfo = { files: 0, skipped: 0 }
let context: number | undefined
const lastLive: Record<string, Reading> = {}
const logLines: Record<string, string[]> = {}
const dirty = new Set<string>()
const notified = new Set<string>()
let prevOverall: Verdict = 'ok'
let timer: { cancel: () => void } | undefined

const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7)
const logPath = (month: string) => `${folder}/log-${month}-${sessionKey}.jsonl`

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
  calib = ((await $.store.get('calib')) as Calib | undefined) ?? {}

  // Earlier readings (all sessions) for this and last month; this session's
  // own lines go back into the buffer so a reload does not lose them.
  const now = await $.clock.now()
  const months = new Set([monthOf(now), monthOf(now - 32 * 24 * 3_600_000)])
  const entries = await $.fs.list(folder).catch(() => [])
  readings = []
  for (const entry of entries) {
    const m = /^log-(\d{4}-\d{2})-(.+)\.jsonl$/.exec(entry.name)
    const month = m?.[1]
    if (!m || !month || !months.has(month) || entry.size > MAX_READ) continue
    const text = await $.fs.read(`${folder}/${entry.name}`).catch(() => '')
    const lines = text.split('\n').filter(Boolean)
    if (m[2] === sessionKey) logLines[month] = lines
    for (const line of lines) {
      try {
        const d = JSON.parse(line)
        if (d.k === 'r' && now - d.t < 8 * 24 * 3_600_000) readings.push({ t: d.t, kind: d.w, p: d.p, r: d.r })
      } catch {}
    }
  }
}

/** Rebuilds hourly usage from Claude Code's own transcripts, cached per file. */
async function scan($: EngineInterface) {
  if (scanning || !base) return
  scanning = true
  await recompute($)
  const startedAt = await $.clock.now()
  const cachePath = `${folder}/history-cache.json`
  const cache: HistoryCache = await $.fs
    .read(cachePath)
    .then(t => JSON.parse(t) as HistoryCache)
    .catch(() => ({ version: 1 as const, files: {} }))
  const next: HistoryCache = { version: 1, files: {} }
  const buckets: HourBuckets = {}
  let files = 0
  let skipped = 0

  const walk = async (dir: string, depth: number): Promise<void> => {
    const list = await $.fs.list(dir).catch(() => [])
    for (const entry of list) {
      const path = `${dir}/${entry.name}`
      if (entry.kind === 'dir' && depth < 3) await walk(path, depth + 1)
      if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
      if (startedAt - entry.mtimeMs > KEEP_MS) continue
      const old = cache.files[path]
      let hours: HourBuckets
      if (old && old.size === entry.size && old.mtimeMs === entry.mtimeMs) {
        hours = old.hours
      } else if (entry.size > MAX_READ) {
        skipped += 1
        continue
      } else {
        const text = await $.fs.read(path).catch(() => '')
        hours = {}
        for (const turn of parseTranscript(text)) addToBuckets(hours, turn)
      }
      files += 1
      next.files[path] = { size: entry.size, mtimeMs: entry.mtimeMs, hours }
      mergeBuckets(buckets, hours)
    }
  }
  await walk(`${base}/projects`, 0)

  scanBuckets = buckets
  scanAt = startedAt
  liveTurns = liveTurns.filter(t => t.t > scanAt)
  scanInfo = { files, skipped }
  scanning = false
  await $.fs.write(cachePath, JSON.stringify(next)).catch(() => undefined)
  await recompute($)
}

function allBuckets(): HourBuckets {
  const b: HourBuckets = {}
  mergeBuckets(b, scanBuckets)
  for (const t of liveTurns) if (t.t > scanAt) addToBuckets(b, t)
  return b
}

async function recompute($: EngineInterface) {
  const now = await $.clock.now()
  const usage = await $.session.usage().catch(() => undefined)
  const limits = usage?.rateLimits ?? []
  context = usage?.context.tokens ?? context
  const buckets = allBuckets()
  const prof = profile(buckets, now)

  const forecasts: Forecast[] = limits
    .filter(l => l.kind === 'five_hour' || l.kind === 'seven_day')
    .map(l =>
      forecast({
        kind: l.kind,
        p: l.percentUsed,
        resetsAt: l.resetsAt ? Date.parse(l.resetsAt) : undefined,
        r: l.resetsAt,
        now,
        k: ratio(calib, l.kind),
        buckets,
        readings,
        perHour: prof.perHour,
        profileDays: prof.days,
      }),
    )
  const overall = worst(forecasts.map(f => f.verdict))
  const worstOne = forecasts.find(f => f.verdict === overall)
  const week = limits.find(l => l.kind === 'seven_day')
  const kWeek = ratio(calib, 'seven_day')

  const next: View = {
    updatedAt: now,
    overall,
    warningKey: `${overall}:${worstOne?.kind ?? ''}`,
    forecasts,
    tips: suggestions({ forecasts, buckets, now, context }),
    calibrated: Object.keys(calib).filter(k => ratio(calib, k) !== undefined),
    history: {
      scanning,
      days: Math.floor(prof.days),
      files: scanInfo.files,
      skipped: scanInfo.skipped,
      busiest: prof.days >= 7 ? busiestDays(prof.perHour) : [],
      pastWeeks: week?.resetsAt && kWeek !== undefined ? pastWeeks(buckets, Date.parse(week.resetsAt), kWeek) : [],
    },
    folder,
  }
  await update($, view, () => next)

  $.ui.status(
    forecasts.length === 0
      ? undefined
      : 'Limits ' +
          forecasts
            .map(f => `${SHORT[f.kind] ?? f.kind} ${fmtPct(f.p)}${f.verdict === 'ok' ? '' : ` → ${VERDICT_TEXT[f.verdict]}`}`)
            .join(' · '),
  )

  // Speak up only when things get worse, or a threshold is crossed.
  if (isWorse(overall, prevOverall) && worstOne) $.ui.toast(worstOne.headline, { timeoutMs: 8000 })
  prevOverall = overall
  for (const l of limits) {
    for (const mark of [80, 90]) {
      const key = `${l.kind}:${l.resetsAt}:${mark}`
      if (l.percentUsed >= mark && !notified.has(key)) {
        notified.add(key)
        $.ui.toast(`${SHORT[l.kind] ?? l.kind} limit at ${fmtPct(l.percentUsed)}`)
      }
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'limits', description: 'Usage limits: forecast, history and suggestions' })
    await init($)
    timer?.cancel()
    timer = $.clock.every(FLUSH_MS, () => {
      void flush($)
        .then(() => recompute($))
        .catch(() => undefined)
    })
    $.clock.after(1000, () => {
      void scan($).catch(() => {
        scanning = false
      })
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
    if (u) {
      const now = await $.clock.now()
      const turn: Turn = {
        t: now,
        model: u.model,
        in: u.input_tokens,
        cw: u.cache_creation_input_tokens,
        cr: u.cache_read_input_tokens,
        out: u.output_tokens,
        sub: e.agentId !== undefined,
      }
      liveTurns.push(turn)
      log(now, { k: 't', m: turn.model, i: turn.in, cw: turn.cw, cr: turn.cr, o: turn.out, s: turn.sub ? 1 : 0 })
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.context.tokens !== undefined) context = e.context.tokens
    for (const l of e.rateLimits) {
      const reading: Reading = { t: now, kind: l.kind, p: l.percentUsed, r: l.resetsAt }
      const last = lastLive[l.kind]
      if (last && last.p === reading.p && last.r === reading.r) continue
      // Learn how many percent this account's usage costs: match the points
      // the window moved to the usage this process saw in between.
      if (last && last.r === reading.r && reading.p > last.p) {
        const du = liveTurns.filter(t => t.t > last.t && t.t <= now).reduce((a, t) => a + units(t), 0)
        calib = addCalib(calib, l.kind, reading.p - last.p, du)
        await $.store.set('calib', calib)
      }
      lastLive[l.kind] = reading
      readings.push(reading)
      log(now, { k: 'r', w: l.kind, p: l.percentUsed, r: l.resetsAt })
    }
    if (e.changed.includes('rateLimits')) await recompute($)
    return next(e)
  })

  on('command.run', { command: 'limits' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Usage limits' })
    const v = await read($, view)
    if (!scanning && (v === null || (await $.clock.now()) - scanAt > 30 * 60_000)) {
      $.clock.after(0, () => {
        void scan($).catch(() => {
        scanning = false
      })
      })
    } else {
      await recompute($)
    }
    return { text: 'Usage limits pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (e.props.hasSurvey || !v || v.overall === 'ok' || (await read($, hiddenKey)) === v.warningKey) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const head = v.forecasts.find(f => f.verdict === v.overall)
    return (
      <Box flexDirection="column">
        <Text bold color={v.overall === 'hold' ? 'error' : 'warning'}>
          {v.overall === 'hold' ? 'Hold on: ' : 'Slow down: '}
          {head?.headline ?? ''}
        </Text>
        {v.tips.slice(0, 2).map(tip => (
          <Text dimColor>• {tip}</Text>
        ))}
        <Box flexDirection="row">
          <Button key="details" label="Details" onPress={() => $.ui.open({ id: PANE, title: 'Usage limits' })} />
          <Text> </Text>
          <Button key="hide" label="Hide" onPress={() => update($, hiddenKey, () => v.warningKey)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const v = await read($, view)
    if (!v) return <Text dimColor>Collecting data…</Text>
    const hist = v.history
    const color = (verdict: Verdict) => (verdict === 'ok' ? 'success' : verdict === 'slow' ? 'warning' : 'error')

    return (
      <Box flexDirection="column">
        {v.forecasts.length === 0 && (
          <Text dimColor>No limit reading yet: it arrives with the next response (subscription plans only).</Text>
        )}
        {v.forecasts.map(f => (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>
              {f.label} {fmtPct(f.p)} {bar(f.p)}
              {f.msToReset !== undefined ? ` resets in ${dur(f.msToReset)}` : ''}
            </Text>
            <Text>
              {f.rate !== undefined
                ? `  speed: ${f.rate.toFixed(1)}%/h (${f.rateBasis})`
                : `  speed: ${f.rateBasis}`}
            </Text>
            {f.pace !== undefined && (
              <Text dimColor>
                {`  even pace now: ${fmtPct(f.pace)} (you are ${f.p <= f.pace ? 'under' : 'over'} by ${Math.round(Math.abs(f.p - f.pace))})`}
              </Text>
            )}
            {f.projected !== undefined && <Text dimColor>{`  at this speed: ~${fmtPct(f.projected)} at reset`}</Text>}
            {f.learned !== undefined && <Text dimColor>{`  your usual pattern: ~${fmtPct(f.learned)} at reset`}</Text>}
            {f.perDayLeft !== undefined && <Text dimColor>{`  available: ~${fmtPct(f.perDayLeft)} per day until reset`}</Text>}
            <Text color={color(f.verdict)} bold>{`  → ${VERDICT_TEXT[f.verdict]}`}</Text>
          </Box>
        ))}

        {v.tips.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>Suggestions</Text>
            {v.tips.map(tip => (
              <Text>• {tip}</Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Your history</Text>
          <Text dimColor>
            {hist.scanning
              ? '  reading past sessions…'
              : `  ${hist.days} days from ${hist.files} transcripts${hist.skipped ? ` (${hist.skipped} too large to read, skipped)` : ''}`}
          </Text>
          {hist.busiest.length > 0 && <Text dimColor>{`  busiest days: ${hist.busiest.join(', ')}`}</Text>}
          {hist.pastWeeks.length > 0 && (
            <Text dimColor>{`  past weeks (estimated): ${hist.pastWeeks.map(p => fmtPct(p)).join(' · ')}  (latest first)`}</Text>
          )}
          {v.forecasts.some(f => !v.calibrated.includes(f.kind)) && (
            <Text dimColor>
              {`  learning: ${v.forecasts
                .filter(f => !v.calibrated.includes(f.kind))
                .map(f => f.label)
                .join(', ')} still needs a few percent of live use to convert tokens into %`}
            </Text>
          )}
        </Box>
        <Text dimColor>{`Data: ${v.folder}`}</Text>
      </Box>
    )
  })
}
