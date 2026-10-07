// Pure logic of the limits mod: no `$`, no I/O, so it can be tested directly.

export type Verdict = 'ok' | 'slow' | 'hold'

/** One reading of a limit window, as the engine reports it. */
export type Reading = { t: number; kind: string; p: number; r?: string }

/** One model turn's cost. `sub` marks a subagent's turn. */
export type Turn = {
  t: number
  model: string
  in: number
  cw: number
  cr: number
  out: number
  sub?: boolean
  ctx?: number
}

/** Usage summed per hour: [units, subagent units, opus units]. */
export type HourBuckets = Record<string, [number, number, number]>

/** Running sums for converting usage units into limit percent, per window. */
export type Calib = Record<string, { dp: number; du: number }>

export type Forecast = {
  kind: string
  label: string
  p: number
  msToReset?: number
  /** Percent per hour at the current speed. */
  rate?: number
  rateBasis: string
  msToLimit?: number
  /** Percent at reset if the current speed continues. */
  projected?: number
  /** Percent at reset from your usual pattern (learned). */
  learned?: number
  /** Where an even pace would be right now. */
  pace?: number
  /** Percent per day still available until reset (weekly). */
  perDayLeft?: number
  verdict: Verdict
  headline: string
}

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY }
export const LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly' }

/** Calibration counts as usable once this many percent points were matched. */
export const MIN_CALIB_POINTS = 3

const VERDICT_RANK: Record<Verdict, number> = { ok: 0, slow: 1, hold: 2 }

export const worst = (vs: Verdict[]): Verdict =>
  vs.reduce<Verdict>((a, v) => (VERDICT_RANK[v] > VERDICT_RANK[a] ? v : a), 'ok')

export const isWorse = (a: Verdict, b: Verdict) => VERDICT_RANK[a] > VERDICT_RANK[b]

/** Relative price of a model family, used to weight its tokens. */
export function modelFactor(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('opus')) return 5
  if (m.includes('haiku')) return 1
  return 3
}

/**
 * A turn's cost in "units": tokens weighted like API prices (cache reads are
 * cheap, output is expensive, Opus costs more), in millions.
 */
export function units(t: Pick<Turn, 'model' | 'in' | 'cw' | 'cr' | 'out'>): number {
  return (modelFactor(t.model) * (t.in + 1.25 * t.cw + 0.1 * t.cr + 5 * t.out)) / 1e6
}

export const hourKey = (t: number) => String(Math.floor(t / HOUR) * HOUR)

export function addToBuckets(b: HourBuckets, turn: Turn) {
  const k = hourKey(turn.t)
  const u = units(turn)
  const cur = b[k] ?? [0, 0, 0]
  b[k] = [
    cur[0] + u,
    cur[1] + (turn.sub ? u : 0),
    cur[2] + (turn.model.toLowerCase().includes('opus') ? u : 0),
  ]
}

export function mergeBuckets(into: HourBuckets, from: HourBuckets) {
  for (const [k, v] of Object.entries(from)) {
    const cur = into[k] ?? [0, 0, 0]
    into[k] = [cur[0] + v[0], cur[1] + v[1], cur[2] + v[2]]
  }
}

/** Sum of bucket units between `from` (inclusive) and `to` (exclusive), prorating the edge hours. */
export function unitsBetween(b: HourBuckets, from: number, to: number): number {
  let sum = 0
  for (const [k, v] of Object.entries(b)) {
    const start = Number(k)
    const end = start + HOUR
    const overlap = Math.min(end, to) - Math.max(start, from)
    if (overlap > 0) sum += (v[0] * overlap) / HOUR
  }
  return sum
}

/**
 * Parses a Claude Code transcript (JSONL) into turns. Streaming writes the
 * same message more than once, so messages are counted once by id.
 */
export function parseTranscript(text: string): Turn[] {
  const seen = new Set<string>()
  const turns: Turn[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const m = d?.message
    const u = m?.usage
    if (d?.type !== 'assistant' || !u || !m.model || m.model === '<synthetic>') continue
    const id = String(m.id ?? d.requestId ?? d.uuid ?? '')
    if (id && seen.has(id)) continue
    if (id) seen.add(id)
    const t = Date.parse(d.timestamp)
    if (!Number.isFinite(t)) continue
    turns.push({
      t,
      model: m.model,
      in: u.input_tokens ?? 0,
      cw: u.cache_creation_input_tokens ?? 0,
      cr: u.cache_read_input_tokens ?? 0,
      out: u.output_tokens ?? 0,
      sub: d.isSidechain === true,
    })
  }
  return turns
}

/** Adds a matched pair (percent moved, units spent) to a window's calibration. */
export function addCalib(c: Calib, kind: string, dp: number, du: number): Calib {
  if (!(dp >= 0) || !(du > 0)) return c
  const cur = c[kind] ?? { dp: 0, du: 0 }
  let next = { dp: cur.dp + dp, du: cur.du + du }
  // Keep it learning: once enough evidence exists, older evidence fades.
  if (next.dp > 200) next = { dp: next.dp / 2, du: next.du / 2 }
  return { ...c, [kind]: next }
}

/** Percent per unit for a window, once enough evidence exists. */
export function ratio(c: Calib, kind: string): number | undefined {
  const cur = c[kind]
  if (!cur || cur.dp < MIN_CALIB_POINTS || cur.du <= 0) return undefined
  return cur.dp / cur.du
}

/** Average units per hour-of-week over the last `weeks` weeks of buckets. */
export function profile(b: HourBuckets, now: number, weeks = 4): { perHour: number[]; days: number } {
  const perHour = new Array(168).fill(0)
  const from = now - weeks * 7 * DAY
  let first = now
  for (const [k, v] of Object.entries(b)) {
    const t = Number(k)
    if (t < from || t >= now) continue
    first = Math.min(first, t)
    perHour[hourOfWeek(t)] += v[0]
  }
  const days = (now - first) / DAY
  const coveredWeeks = Math.max(1, Math.min(weeks, days / 7))
  return { perHour: perHour.map(x => x / coveredWeeks), days }
}

export function hourOfWeek(t: number): number {
  const d = new Date(t)
  return d.getDay() * 24 + d.getHours()
}

/** Expected units from `from` to `to` following the profile. */
export function expectedUnits(perHour: number[], from: number, to: number): number {
  let sum = 0
  for (let t = Math.floor(from / HOUR) * HOUR; t < to; t += HOUR) {
    const overlap = Math.min(t + HOUR, to) - Math.max(t, from)
    if (overlap > 0) sum += ((perHour[hourOfWeek(t)] ?? 0) * overlap) / HOUR
  }
  return sum
}

/** Percent per hour from readings of one window, if they span long enough. */
export function readingRate(readings: Reading[], kind: string, r: string | undefined, now: number, lookback: number) {
  const xs = readings.filter(x => x.kind === kind && x.r === r && x.t >= now - lookback).sort((a, b) => a.t - b.t)
  const first = xs[0]
  const last = xs[xs.length - 1]
  if (!first || !last || xs.length < 2) return undefined
  const span = last.t - first.t
  if (span < lookback / 4) return undefined
  return Math.max(0, ((last.p - first.p) / span) * HOUR)
}

export type ForecastInput = {
  kind: string
  p: number
  resetsAt?: number
  now: number
  /** Percent per unit, when calibrated. */
  k?: number
  buckets: HourBuckets
  readings: Reading[]
  r?: string
  perHour?: number[]
  profileDays?: number
}

export function forecast(x: ForecastInput): Forecast {
  const L = WINDOW_MS[x.kind]
  const label = LABEL[x.kind] ?? x.kind
  const msToReset = x.resetsAt !== undefined ? Math.max(0, x.resetsAt - x.now) : undefined
  const isWeek = x.kind === 'seven_day'
  // The 5-hour window is judged on the last hour; the week on the last day,
  // since nobody works 24 hours straight.
  const lookback = isWeek ? DAY : HOUR

  let rate: number | undefined
  let rateBasis = 'not enough data yet'
  if (x.k !== undefined) {
    rate = (unitsBetween(x.buckets, x.now - lookback, x.now) * x.k) / (lookback / HOUR)
    rateBasis = isWeek ? 'your last 24 hours' : 'your last hour'
  } else {
    const rr = readingRate(x.readings, x.kind, x.r, x.now, lookback)
    if (rr !== undefined) {
      rate = rr
      rateBasis = isWeek ? 'your last 24 hours' : 'your last hour'
    }
  }

  const pace = L && msToReset !== undefined ? clamp((1 - msToReset / L) * 100, 0, 100) : undefined
  const hoursToReset = msToReset !== undefined ? msToReset / HOUR : undefined
  const projected = rate !== undefined && hoursToReset !== undefined ? x.p + rate * hoursToReset : undefined
  const msToLimit = rate !== undefined && rate > 0 ? ((100 - x.p) / rate) * HOUR : undefined

  let learned: number | undefined
  if (x.k !== undefined && x.perHour && (x.profileDays ?? 0) >= 3 && x.resetsAt !== undefined) {
    learned = x.p + expectedUnits(x.perHour, x.now, x.resetsAt) * x.k
  }

  const perDayLeft = isWeek && msToReset !== undefined && msToReset > 0
    ? Math.max(0, 100 - x.p) / Math.max(msToReset / DAY, 1 / 24)
    : undefined

  let verdict: Verdict = 'ok'
  const runsOut = msToLimit !== undefined && msToReset !== undefined && msToLimit < msToReset
  if (x.p >= 95) verdict = 'hold'
  else if (runsOut) verdict = msToLimit! < (isWeek ? DAY : 45 * 60_000) ? 'hold' : 'slow'
  else if (learned !== undefined && learned > 100) verdict = 'slow'
  else if (x.p >= 85) verdict = 'slow'

  let headline: string
  if (x.p >= 95) headline = `${label} limit almost used (${fmtPct(x.p)}).`
  else if (runsOut) headline = `${label}: at this speed you hit the limit in ~${dur(msToLimit!)}, reset is in ${dur(msToReset!)}.`
  else if (learned !== undefined && learned > 100) headline = `${label}: your usual pattern would reach ~${fmtPct(learned)} before reset in ${dur(msToReset!)}.`
  else if (projected !== undefined && msToReset !== undefined) headline = `${label}: on track for ~${fmtPct(Math.min(projected, 100))} at reset in ${dur(msToReset)}.`
  else if (msToReset !== undefined) headline = `${label}: ${fmtPct(x.p)} used, reset in ${dur(msToReset)}.`
  else headline = `${label}: ${fmtPct(x.p)} used.`

  return { kind: x.kind, label, p: x.p, msToReset, rate, rateBasis, msToLimit, projected, learned, pace, perDayLeft, verdict, headline }
}

export type SuggestionInput = {
  forecasts: Forecast[]
  buckets: HourBuckets
  now: number
  /** Context size of the main thread, in tokens. */
  context?: number
}

export function suggestions(x: SuggestionInput): string[] {
  const out: string[] = []
  const short = x.forecasts.find(f => f.kind === 'five_hour')
  const week = x.forecasts.find(f => f.kind === 'seven_day')
  const anyPressure = x.forecasts.some(f => f.verdict !== 'ok')

  let total = 0
  let sub = 0
  let opus = 0
  for (const [k, v] of Object.entries(x.buckets)) {
    if (Number(k) < x.now - 5 * HOUR) continue
    total += v[0]
    sub += v[1]
    opus += v[2]
  }

  if (anyPressure) {
    if ((x.context ?? 0) > 120_000) {
      out.push(`Your context is ~${Math.round((x.context ?? 0) / 1000)}k tokens and every message re-sends it: /compact, or /clear when you switch topics.`)
    }
    if (total > 0 && opus / total > 0.6) {
      out.push('Most recent usage is Opus. Sonnet for routine work (/model) makes the same limit last about 1.7× longer.')
    }
    if (total > 0 && sub / total > 0.4) {
      out.push(`Subagents made ${Math.round((sub / total) * 100)}% of recent usage: fewer parallel agents slow the burn most.`)
    }
    if (short && short.verdict !== 'ok' && short.msToReset !== undefined && (!week || week.verdict === 'ok')) {
      out.push(`The 5-hour window resets in ${dur(short.msToReset)}: a break until then costs nothing from the week.`)
    }
    if (week && week.verdict !== 'ok' && week.perDayLeft !== undefined) {
      out.push(`To last the week, keep to about ${fmtPct(week.perDayLeft)} per day until the reset.`)
    }
  } else if (week && week.pace !== undefined && week.p < week.pace - 10 && week.perDayLeft !== undefined) {
    out.push(`You're ${Math.round(week.pace - week.p)} points under an even pace this week: about ${fmtPct(week.perDayLeft)} per day is available, room for bigger tasks.`)
  }
  return out
}

/** Estimated weekly percent of the past weeks, from the current reset backwards. */
export function pastWeeks(b: HourBuckets, resetsAt: number, k: number, count = 4): number[] {
  const res: number[] = []
  for (let i = 1; i <= count; i++) {
    const end = resetsAt - i * 7 * DAY
    res.push(unitsBetween(b, end - 7 * DAY, end) * k)
  }
  return res
}

/** The busiest days of the week in the profile, by name. */
export function busiestDays(perHour: number[], n = 2): string[] {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const perDay = names.map((_, d) => perHour.slice(d * 24, d * 24 + 24).reduce((a, x) => a + x, 0))
  if (perDay.every(x => x === 0)) return []
  return perDay.map((v, d) => ({ v, d })).sort((a, b) => b.v - a.v).slice(0, n).map(x => names[x.d] ?? '')
}

export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

export const fmtPct = (p: number) => `${Math.round(p)}%`

export function dur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}`
  return `${Math.round(h / 24)}d`
}

export function bar(p: number, width = 18): string {
  const n = clamp(Math.round((p / 100) * width), 0, width)
  return '█'.repeat(n) + '░'.repeat(width - n)
}

export const VERDICT_TEXT: Record<Verdict, string> = { ok: 'OK', slow: 'slow down', hold: 'hold on' }
