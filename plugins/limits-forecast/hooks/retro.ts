// Retrospective data, pure: the log format, daily rollups of transcripts, and
// the export for looking back (limit hits, tips followed, forecast quality).

import { evaluate, isOpus, LABEL, mergeHits, normReset, units } from './model'
import type { Compaction, ForecastLog, Hit, Quality, Reading, Transcript } from './model'

const MINUTE = 60_000

// ── The log ─────────────────────────────────────────────────────────────────
// One JSON object per line in log-YYYY-MM-<session>.jsonl:
//   r  a window moved:  { w, p, r }
//   t  a turn ended:    { m, i, cw, cr, o, s, x?, d, a? }  (x context, d duration ms, a aborted)
//   f  a forecast:      { w, r, p, pt, lo?, hi?, risk?, n?, b? }
//   e  an event:        { e: warn | hide | pane | tip | compact | export, ... }

export type LoggedTurn = { t: number; s: string; m?: string; i: number; cw: number; cr: number; o: number; sub: boolean; x?: number; d?: number; a: boolean }
export type LoggedEvent = { t: number; s: string; e: string; [k: string]: unknown }
export type Log = { readings: Reading[]; forecasts: ForecastLog[]; turns: LoggedTurn[]; events: LoggedEvent[] }

export const emptyLog = (): Log => ({ readings: [], forecasts: [], turns: [], events: [] })

export function forecastEntry(f: ForecastLog): Record<string, unknown> {
  const { t, kind, ...rest } = f
  return { t, k: 'f', w: kind, ...rest }
}

export function parseLog(text: string, session: string, into: Log = emptyLog()): Log {
  for (const line of text.split('\n')) {
    if (!line) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof d?.t !== 'number') continue
    if (d.k === 'r') into.readings.push({ t: d.t, kind: d.w, p: d.p, r: typeof d.r === 'string' ? normReset(d.r) : d.r })
    else if (d.k === 'f') {
      const { k: _k, w, ...rest } = d
      into.forecasts.push({ ...rest, kind: w, r: normReset(String(rest.r)) })
    } else if (d.k === 't') {
      into.turns.push({ t: d.t, s: session, m: d.m, i: d.i ?? 0, cw: d.cw ?? 0, cr: d.cr ?? 0, o: d.o ?? 0, sub: d.s === 1, x: d.x, d: d.d, a: d.a === 1 })
    } else if (d.k === 'e') {
      const { k: _k, ...rest } = d
      into.events.push({ ...rest, s: session })
    }
  }
  return into
}

/** `log-2026-10-abcdef12.jsonl` → month and session, or undefined. */
export function logName(name: string) {
  const m = /^log-(\d{4}-\d{2})-(.+)\.jsonl$/.exec(name)
  return m ? { month: m[1]!, session: m[2]! } : undefined
}

// ── Daily rollups ───────────────────────────────────────────────────────────
// Claude Code deletes old transcripts (cleanupPeriodDays, 30 by default), so
// each transcript's usage is kept per day in rollup-YYYY-MM.json, by file.

/**
 * One transcript's day. `m` per model: [turns, input, cache write, cache read,
 * output, subagent turns]; `effort` and `attr`: [turns, units]; `dur`: [turns,
 * ms]; `q`: active quarter-hours.
 */
export type DayRow = {
  m: Record<string, number[]>
  tools: Record<string, number>
  q: number[]
  effort?: Record<string, number[]>
  attr?: Record<string, number[]>
  dur?: number[]
  thinkMs?: number
  aborted?: number
  hits?: Hit[]
  compact?: Compaction[]
}
export type FileRollup = { project: string; days: Record<string, DayRow> }
export type Rollup = { version: 1; files: Record<string, FileRollup> }

export const pad = (n: number) => String(n).padStart(2, '0')
export const localDay = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The project a transcript belongs to: the last part of its cwd, else its folder. */
export function projectOf(text: string, path: string): string {
  const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text)
  if (m) {
    const cwd = JSON.parse(`"${m[1]}"`) as string
    const name = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    if (name) return name
  }
  return path.split('/').slice(-2, -1)[0] ?? ''
}

export function rollupTranscript(tr: Transcript): Record<string, DayRow> {
  const days: Record<string, DayRow> = {}
  const day = (t: number) => (days[localDay(t)] ??= { m: {}, tools: {}, q: [] })
  const add = (rec: Record<string, number[]>, key: string, u: number) => {
    const v = (rec[key] ??= [0, 0])
    v[0]! += 1
    v[1]! += u
  }
  for (const t of tr.turns) {
    const row = day(t.t)
    const m = (row.m[t.model] ??= [0, 0, 0, 0, 0, 0])
    m[0]! += 1
    m[1]! += t.in
    m[2]! += t.cw
    m[3]! += t.cr
    m[4]! += t.out
    m[5]! += t.sub ? 1 : 0
    for (const name of t.tools ?? []) row.tools[name] = (row.tools[name] ?? 0) + 1
    const d = new Date(t.t)
    const q = d.getHours() * 4 + Math.floor(d.getMinutes() / 15)
    if (!row.q.includes(q)) row.q.push(q)
    const u = units(t)
    if (t.effort) add((row.effort ??= {}), t.effort, u)
    for (const a of t.attr ?? []) add((row.attr ??= {}), a, u)
    if (t.thinkMs) row.thinkMs = (row.thinkMs ?? 0) + t.thinkMs
    if (t.aborted) row.aborted = (row.aborted ?? 0) + 1
  }
  for (const x of tr.durations) {
    const row = day(x.t)
    row.dur = [(row.dur?.[0] ?? 0) + 1, (row.dur?.[1] ?? 0) + x.ms]
  }
  for (const h of tr.hits) (day(h.t).hits ??= []).push(h)
  for (const c of tr.compactions) (day(c.t).compact ??= []).push(c)
  for (const row of Object.values(days)) row.q.sort((a, b) => a - b)
  return days
}

export function byMonth(days: Record<string, DayRow>): Record<string, Record<string, DayRow>> {
  const out: Record<string, Record<string, DayRow>> = {}
  for (const [day, row] of Object.entries(days)) (out[day.slice(0, 7)] ??= {})[day] = row
  return out
}

// ── Analyses ────────────────────────────────────────────────────────────────

/** Windows that reached the limit, from readings at 100% and from refused requests in transcripts. */
export function limitHits(readings: Reading[], hits: Hit[] = []): Hit[] {
  const fromReadings = readings
    .filter(x => x.p >= 99.5 && x.r)
    .map(x => ({ t: x.t, kind: x.kind, r: normReset(x.r!), tries: 0 }))
  return mergeHits([...hits, ...fromReadings]).sort((a, b) => a.t - b.t)
}

export const blockedMs = (h: Hit) => Math.max(0, Date.parse(h.r) - h.t)

const turnUnits = (t: LoggedTurn) => (t.m ? units({ model: t.m, in: t.i, cw: t.cw, cr: t.cr, out: t.o }) : 0)

/**
 * Whether a shown tip was followed within an hour, in the session it was shown
 * in. Undefined where the tip asks for nothing observable.
 */
export function tipFollowed(tip: LoggedEvent, turns: LoggedTurn[], events: LoggedEvent[]): boolean | undefined {
  const w = 60 * MINUTE
  const mine = turns.filter(t => t.s === tip.s)
  const after = mine.filter(t => t.t > tip.t && t.t <= tip.t + w)
  const before = mine.filter(t => t.t <= tip.t && t.t > tip.t - w)
  switch (tip.id) {
    case 'context': {
      if (events.some(e => e.s === tip.s && e.e === 'compact' && e.t > tip.t && e.t <= tip.t + w)) return true
      const last = [...before].reverse().find(t => !t.sub && t.x !== undefined)?.x
      return last !== undefined && after.some(t => !t.sub && t.x !== undefined && t.x < last / 2)
    }
    case 'model':
      return after.some(t => !t.sub && t.m !== undefined && !isOpus(t.m))
    case 'subagents': {
      const share = (ts: LoggedTurn[]) => {
        const all = ts.reduce((a, t) => a + turnUnits(t), 0)
        return all > 0 ? ts.filter(t => t.sub).reduce((a, t) => a + turnUnits(t), 0) / all : undefined
      }
      const b = share(before)
      const a = share(after)
      return b !== undefined && a !== undefined ? a < b / 2 : undefined
    }
    case 'break':
      return !mine.some(t => t.t > tip.t && t.t <= tip.t + 30 * MINUTE)
    default:
      return undefined
  }
}

// ── Export ──────────────────────────────────────────────────────────────────

const cell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : typeof v === 'number' ? String(Math.round(v * 1e4) / 1e4) : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export const csv = (header: string[], rows: unknown[][]) => [header, ...rows].map(r => r.map(cell).join(',')).join('\n') + '\n'
const iso = (t: number) => new Date(t).toISOString()
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined)

export type ExportInput = { log: Log; rollups: Rollup[]; now: number }

/** The export folder's files, by name: CSV tables plus a summary for presentations. */
export function buildExport(x: ExportInput): Record<string, string> {
  const files: Record<string, FileRollup> = {}
  for (const r of x.rollups) {
    for (const [path, f] of Object.entries(r.files)) {
      const cur = (files[path] ??= { project: f.project, days: {} })
      Object.assign(cur.days, f.days)
    }
  }

  const usage: unknown[][] = []
  const tools: unknown[][] = []
  const active = new Map<string, Set<number>>()
  const time = new Map<string, { turnMs: number; thinkMs: number; aborted: number }>()
  const efforts: unknown[][] = []
  const attrs: unknown[][] = []
  const compactRows: unknown[][] = []
  const transcriptHits: Hit[] = []
  const byEffort: Record<string, { turns: number; usd: number }> = {}
  const byAttr: Record<string, { turns: number; usd: number }> = {}
  const sum = (rec: Record<string, { turns: number; usd: number }>, key: string, n: number, usd: number) => {
    const v = (rec[key] ??= { turns: 0, usd: 0 })
    v.turns += n
    v.usd += usd
  }
  const byModel: Record<string, { turns: number; usd: number }> = {}
  const byProject: Record<string, { turns: number; usd: number }> = {}
  let turnsTotal = 0
  let usdTotal = 0
  const tok = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }
  for (const f of Object.values(files)) {
    for (const [day, row] of Object.entries(f.days)) {
      for (const [model, [n = 0, i = 0, cw = 0, cr = 0, o = 0, sub = 0]] of Object.entries(row.m)) {
        const usd = units({ model, in: i, cw, cr, out: o })
        usage.push([day, f.project, model, n, i, cw, cr, o, sub, usd])
        turnsTotal += n
        usdTotal += usd
        tok.input += i
        tok.cacheWrite += cw
        tok.cacheRead += cr
        tok.output += o
        const bm = (byModel[model] ??= { turns: 0, usd: 0 })
        bm.turns += n
        bm.usd += usd
        const bp = (byProject[f.project] ??= { turns: 0, usd: 0 })
        bp.turns += n
        bp.usd += usd
      }
      for (const [tool, n] of Object.entries(row.tools)) tools.push([day, f.project, tool, n])
      for (const [effort, [n = 0, usd = 0]] of Object.entries(row.effort ?? {})) {
        efforts.push([day, f.project, effort, n, usd])
        sum(byEffort, effort, n, usd)
      }
      for (const [key, [n = 0, usd = 0]] of Object.entries(row.attr ?? {})) {
        const [kind = '', ...name] = key.split(':')
        attrs.push([day, f.project, kind, name.join(':'), n, usd])
        sum(byAttr, key, n, usd)
      }
      const tm = time.get(day) ?? { turnMs: 0, thinkMs: 0, aborted: 0 }
      tm.turnMs += row.dur?.[1] ?? 0
      tm.thinkMs += row.thinkMs ?? 0
      tm.aborted += row.aborted ?? 0
      time.set(day, tm)
      for (const c of row.compact ?? []) compactRows.push([iso(c.t), f.project, c.trigger, c.pre, c.post])
      transcriptHits.push(...(row.hits ?? []))
      const set = active.get(day) ?? new Set<number>()
      for (const q of row.q) set.add(q)
      active.set(day, set)
    }
  }
  usage.sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  for (const rows of [tools, efforts, attrs, compactRows]) rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  const activeRows = [...active].sort(([a], [b]) => a.localeCompare(b)).map(([day, s]) => {
    const tm = time.get(day)
    return [day, s.size / 4, (tm?.turnMs ?? 0) / 3_600_000, (tm?.thinkMs ?? 0) / 3_600_000, tm?.aborted ?? 0]
  })

  const log = x.log
  const readings = [...log.readings].sort((a, b) => a.t - b.t)
  const hits = limitHits(readings, transcriptHits)
  const final = new Map<string, number>()
  for (const r of readings) final.set(`${r.kind}|${r.r}`, Math.max(final.get(`${r.kind}|${r.r}`) ?? 0, r.p))
  const quality: Record<string, Quality> = {}
  for (const kind of ['five_hour', 'seven_day']) quality[kind] = evaluate(log.forecasts, readings, kind, x.now, 0)

  const tips: Record<string, { shown: number; followed: number; measurable: number }> = {}
  const tipRows: unknown[][] = []
  for (const e of log.events.filter(e => e.e === 'tip')) {
    const followed = tipFollowed(e, log.turns, log.events)
    const s = (tips[String(e.id)] ??= { shown: 0, followed: 0, measurable: 0 })
    s.shown += 1
    if (followed !== undefined) s.measurable += 1
    if (followed) s.followed += 1
    tipRows.push([iso(e.t), e.s, e.id, followed === undefined ? '' : followed ? 'yes' : 'no'])
  }
  const count = (name: string) => log.events.filter(e => e.e === name).length
  const durations = log.turns.filter(t => !t.sub && t.d !== undefined).map(t => t.d!)

  const round = (v: number) => Math.round(v * 100) / 100
  const summary = {
    generatedAt: iso(x.now),
    note: 'usdEquivalent is the usage priced at API list prices; it is not what a subscription costs.',
    days: activeRows.length,
    from: activeRows[0]?.[0],
    to: activeRows[activeRows.length - 1]?.[0],
    activeHours: activeRows.reduce((a, r) => a + Number(r[1]), 0),
    turns: turnsTotal,
    tokens: tok,
    cacheHitRate: tok.cacheRead / Math.max(1, tok.input + tok.cacheWrite + tok.cacheRead),
    usdEquivalent: round(usdTotal),
    byModel: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, { turns: v.turns, usd: round(v.usd) }])),
    byProject: Object.fromEntries(Object.entries(byProject).sort((a, b) => b[1].usd - a[1].usd).map(([k, v]) => [k, { turns: v.turns, usd: round(v.usd) }])),
    limitHits: Object.fromEntries(['five_hour', 'seven_day'].map(kind => {
      const hs = hits.filter(h => h.kind === kind)
      return [kind, { count: hs.length, blockedHours: round(hs.reduce((a, h) => a + blockedMs(h), 0) / 3_600_000), retries: hs.reduce((a, h) => a + Math.max(0, h.tries - 1), 0) }]
    })),
    turnsLogged: {
      main: log.turns.filter(t => !t.sub).length,
      aborted: log.turns.filter(t => t.a).length,
      medianDurationSec: durations.length ? round(durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)]! / 1000) : undefined,
    },
    compactions: {
      manual: compactRows.filter(r => r[2] === 'manual').length,
      auto: compactRows.filter(r => r[2] === 'auto').length,
      medianTokensBefore: median(compactRows.map(r => Number(r[3]))),
      medianTokensAfter: median(compactRows.map(r => Number(r[4]))),
    },
    time: {
      turnHours: round(activeRows.reduce((a, r) => a + Number(r[2]), 0)),
      thinkingHours: round(activeRows.reduce((a, r) => a + Number(r[3]), 0)),
      interruptedAnswers: activeRows.reduce((a, r) => a + Number(r[4]), 0),
    },
    byEffort: Object.fromEntries(Object.entries(byEffort).map(([k, v]) => [k, { turns: v.turns, usd: round(v.usd) }])),
    byAttribution: Object.fromEntries(
      Object.entries(byAttr).sort((a, b) => b[1].usd - a[1].usd).slice(0, 20).map(([k, v]) => [k, { turns: v.turns, usd: round(v.usd) }]),
    ),
    warnings: { shown: count('warn'), hidden: count('hide'), paneOpened: count('pane') },
    tips,
    forecastQuality: quality,
  }

  return {
    'usage-daily.csv': csv(['date', 'project', 'model', 'turns', 'input', 'cache_write', 'cache_read', 'output', 'subagent_turns', 'usd_equivalent'], usage),
    'tools-daily.csv': csv(['date', 'project', 'tool', 'calls'], tools),
    'active-daily.csv': csv(['date', 'active_hours', 'turn_hours', 'thinking_hours', 'interrupted_answers'], activeRows),
    'effort-daily.csv': csv(['date', 'project', 'effort', 'turns', 'usd_equivalent'], efforts),
    'attribution-daily.csv': csv(['date', 'project', 'kind', 'name', 'turns', 'usd_equivalent'], attrs),
    'compactions.csv': csv(['time', 'project', 'trigger', 'tokens_before', 'tokens_after'], compactRows),
    'limits.csv': csv(['time', 'window', 'percent', 'resets_at'], readings.map(r => [iso(r.t), LABEL[r.kind] ?? r.kind, r.p, r.r])),
    'limit-hits.csv': csv(['time', 'window', 'resets_at', 'blocked_hours', 'retries'], hits.map(h => [iso(h.t), LABEL[h.kind] ?? h.kind, h.r, blockedMs(h) / 3_600_000, Math.max(0, h.tries - 1)])),
    'forecasts.csv': csv(
      ['time', 'window', 'percent', 'forecast', 'lo80', 'hi80', 'risk', 'samples', 'baseline', 'resets_at', 'final'],
      [...log.forecasts].sort((a, b) => a.t - b.t).map(f => [iso(f.t), LABEL[f.kind] ?? f.kind, f.p, f.pt, f.lo, f.hi, f.risk, f.n, f.b, f.r, Date.parse(f.r) <= x.now ? final.get(`${f.kind}|${f.r}`) : undefined]),
    ),
    'turns.csv': csv(
      ['time', 'session', 'model', 'input', 'cache_write', 'cache_read', 'output', 'subagent', 'context', 'duration_ms', 'aborted'],
      [...log.turns].sort((a, b) => a.t - b.t).map(t => [iso(t.t), t.s, t.m, t.i, t.cw, t.cr, t.o, t.sub ? 1 : 0, t.x, t.d, t.a ? 1 : 0]),
    ),
    'events.csv': csv(
      ['time', 'session', 'event', 'detail'],
      [...log.events].sort((a, b) => a.t - b.t).map(e => {
        const { t, s, e: name, ...rest } = e
        return [iso(t), s, name, Object.keys(rest).length ? JSON.stringify(rest) : '']
      }),
    ),
    'tips.csv': csv(['time', 'session', 'tip', 'followed'], tipRows),
    'summary.json': JSON.stringify(summary, null, 2) + '\n',
  }
}
