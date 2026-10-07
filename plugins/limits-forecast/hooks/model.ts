// Pure logic of the limits mod: no `$`, no I/O, so it can be tested directly.

import { cv, mean, quantile, ratioFit, ratioOfTwo, slope } from './stats'

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
  /** Transcripts only: tool names the message called, effort level, what it is attributed to. */
  tools?: string[]
  effort?: string
  /** `skill:x`, `plugin:x`, `mcp:server`, `agent:type`. */
  attr?: string[]
  thinkMs?: number
  aborted?: boolean
}

/** Usage summed per 15 minutes: [units, subagent units, opus units]. */
export type Buckets = Record<string, [number, number, number]>

/** Usage between two times, edge buckets prorated: [units, subagent units, opus units]. */
export type Between = (from: number, to: number) => [number, number, number]

/** What the mod has learned about converting usage units into percent for one window. */
export type Calib = {
  kind: string
  /** Percent per unit, once enough evidence exists. */
  k?: number
  /** Standard error of k, from 3 matched stretches on. */
  se?: number
  /** Matched stretches used. */
  n: number
  /** Percent points those stretches moved. */
  points: number
}

/** One logged forecast, to be scored once its window has reset. */
export type ForecastLog = {
  t: number
  kind: string
  r: string
  p: number
  /** Point forecast at reset. */
  pt: number
  /** 80% prediction interval. */
  lo?: number
  hi?: number
  /** Probability of reaching 100% before reset. */
  risk?: number
  n?: number
  /** Baseline: the current speed held constant. */
  b?: number
}

export type Forecast = {
  kind: string
  label: string
  p: number
  msToReset?: number
  /** Percent per hour at the current speed. */
  rate?: number
  rateBasis: string
  msToLimit?: number
  /** Point forecast of the percent at reset. */
  projected?: number
  /** 80% prediction interval of the percent at reset. */
  lo?: number
  hi?: number
  /** Probability of reaching the limit before reset. */
  risk?: number
  /** How many past stretches the interval and risk come from, and of what. */
  samples?: number
  sampleUnit?: 'days' | 'weeks'
  /** The current speed held constant until reset: the baseline forecasts are scored against. */
  baseline?: number
  /** Where an even pace would be right now. */
  pace?: number
  /** Percent per day still available until reset (weekly). */
  perDayLeft?: number
  verdict: Verdict
  headline: string
}

export type Tip = { id: string; text: string }

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const BUCKET = 15 * MINUTE
export const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY }
export const LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly' }
export const SHORT: Record<string, string> = { five_hour: '5h', seven_day: 'wk' }
export const VERDICT_TEXT: Record<Verdict, string> = { ok: 'OK', slow: 'SLOW DOWN', hold: 'HOLD ON' }

/** Calibration counts as usable once this many percent points were matched. */
export const MIN_CALIB_POINTS = 3
/** Evidence older than this halves in weight. */
const HALF_LIFE = 14 * DAY
/** Calibration and scoring look back this far. */
export const LOOKBACK_DAYS = 28
/** Shortest stretch between two readings that is matched to usage. */
const MIN_SPAN: Record<string, number> = { five_hour: HOUR, seven_day: 12 * HOUR }
/** How long a deviation from the usual pattern is expected to last. */
const TAU: Record<string, number> = { five_hour: HOUR, seven_day: 12 * HOUR }
const Z80 = 1.2816

const VERDICT_RANK: Record<Verdict, number> = { ok: 0, slow: 1, hold: 2 }

export const worst = (vs: Verdict[]): Verdict =>
  vs.reduce<Verdict>((a, v) => (VERDICT_RANK[v] > VERDICT_RANK[a] ? v : a), 'ok')

export const isWorse = (a: Verdict, b: Verdict) => VERDICT_RANK[a] > VERDICT_RANK[b]

export const isOpus = (model: string) => model.toLowerCase().includes('opus')

/** Relative price of a model family, used to weight its tokens. */
export function modelFactor(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('opus')) return 5
  if (m.includes('haiku')) return 1
  return 3
}

/**
 * A turn's cost in "units": tokens weighted like API list prices (cache reads
 * are cheap, output is expensive, Opus costs more). One unit is about one US
 * dollar at those prices.
 */
export function units(t: Pick<Turn, 'model' | 'in' | 'cw' | 'cr' | 'out'>): number {
  return (modelFactor(t.model) * (t.in + 1.25 * t.cw + 0.1 * t.cr + 5 * t.out)) / 1e6
}

export const bucketKey = (t: number) => String(Math.floor(t / BUCKET) * BUCKET)

export function addToBuckets(b: Buckets, turn: Turn) {
  const k = bucketKey(turn.t)
  const u = units(turn)
  const cur = b[k] ?? [0, 0, 0]
  b[k] = [cur[0] + u, cur[1] + (turn.sub ? u : 0), cur[2] + (isOpus(turn.model) ? u : 0)]
}

export function mergeBuckets(into: Buckets, from: Buckets) {
  for (const [k, v] of Object.entries(from)) {
    const cur = into[k] ?? [0, 0, 0]
    into[k] = [cur[0] + v[0], cur[1] + v[1], cur[2] + v[2]]
  }
}

/** Prefix sums over the buckets, so any range sums in O(log n). */
export function usageIndex(b: Buckets): Between {
  const ks = Object.keys(b).map(Number).sort((x, y) => x - y)
  const vs = ks.map(k => b[String(k)]!)
  const cum: [number, number, number][] = [[0, 0, 0]]
  for (const v of vs) {
    const c = cum[cum.length - 1]!
    cum.push([c[0] + v[0], c[1] + v[1], c[2] + v[2]])
  }
  const lower = (x: number) => {
    let lo = 0
    let hi = ks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ks[mid]! < x) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  return (from, to) => {
    if (!(to > from)) return [0, 0, 0]
    const i0 = lower(from - BUCKET + 1)
    const i1 = lower(to)
    if (i1 <= i0) return [0, 0, 0]
    const a = cum[i0]!
    const z = cum[i1]!
    const res: [number, number, number] = [z[0] - a[0], z[1] - a[1], z[2] - a[2]]
    for (const i of i1 - 1 === i0 ? [i0] : [i0, i1 - 1]) {
      const start = ks[i]!
      const outside = 1 - (Math.min(start + BUCKET, to) - Math.max(start, from)) / BUCKET
      const v = vs[i]!
      for (let j = 0; j < 3; j++) res[j]! -= v[j]! * outside
    }
    return res
  }
}

/** Earliest bucket, i.e. how far back the history goes. */
export const firstBucket = (b: Buckets) => Object.keys(b).reduce((a, k) => Math.min(a, Number(k)), Infinity)

/** A window that ran out: when the first refused request came, and how often it was retried. */
export type Hit = { t: number; kind: string; r: string; tries: number }
export type Compaction = { t: number; trigger: string; pre: number; post: number }
export type Transcript = {
  turns: Turn[]
  hits: Hit[]
  compactions: Compaction[]
  /** Main-thread turn durations Claude Code recorded. */
  durations: { t: number; ms: number }[]
}

/** One spelling per reset time, so readings of the same window group together. */
export function normReset(r: string): string {
  const t = Date.parse(r)
  return Number.isFinite(t) ? new Date(t).toISOString() : r
}

const ATTRIBUTION: [string, string][] = [
  ['attributionSkill', 'skill'],
  ['attributionPlugin', 'plugin'],
  ['attributionMcpServer', 'mcp'],
  ['attributionAgent', 'agent'],
]

/**
 * Parses a Claude Code transcript (JSONL). Claude Code writes each content
 * block of a message as its own line with the same usage, so usage is counted
 * once per message id and tool calls are collected across its lines. Also
 * picks up refused requests (a limit hit), compactions and turn durations.
 */
/** The only transcript lines the parser reads; everything else can be dropped unread. */
export const TRANSCRIPT_LINE = /"usage"|"quotaLimits"|"compact_boundary"|"turn_duration"/

export function parseTranscript(text: string): Transcript {
  const byId = new Map<string, Turn>()
  const hits = new Map<string, Hit>()
  const out: Transcript = { turns: [], hits: [], compactions: [], durations: [] }
  for (const line of text.split('\n')) {
    if (!TRANSCRIPT_LINE.test(line)) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const t = Date.parse(d?.timestamp)
    if (!Number.isFinite(t)) continue

    if (d.type === 'system') {
      const c = d.compactMetadata
      if (d.subtype === 'compact_boundary' && c) out.compactions.push({ t, trigger: String(c.trigger ?? ''), pre: c.preTokens ?? 0, post: c.postTokens ?? 0 })
      if (d.subtype === 'turn_duration' && typeof d.durationMs === 'number' && !d.isSidechain) out.durations.push({ t, ms: d.durationMs })
      continue
    }
    if (d.type !== 'assistant') continue

    const q = d.quotaLimits
    if (d.error === 'rate_limit' && q && typeof q.rateLimitType === 'string' && typeof q.resetsAt === 'number') {
      const r = new Date(q.resetsAt * 1000).toISOString()
      const key = `${q.rateLimitType}|${r}`
      const hit = hits.get(key)
      if (hit) hit.tries += 1
      else hits.set(key, { t, kind: q.rateLimitType, r, tries: 1 })
      continue
    }

    const m = d.message
    const u = m?.usage
    if (!u || !m.model || m.model === '<synthetic>') continue
    const tools = Array.isArray(m.content)
      ? m.content.filter((c: any) => c?.type === 'tool_use' && typeof c.name === 'string').map((c: any) => c.name as string)
      : []
    const id = String(m.id ?? d.requestId ?? d.uuid ?? '')
    const seen = id ? byId.get(id) : undefined
    if (seen) {
      if (tools.length) seen.tools = [...(seen.tools ?? []), ...tools]
      if (d.isAbortedMidStream === true) seen.aborted = true
      continue
    }
    const turn: Turn = {
      t,
      model: m.model,
      in: u.input_tokens ?? 0,
      cw: u.cache_creation_input_tokens ?? 0,
      cr: u.cache_read_input_tokens ?? 0,
      out: u.output_tokens ?? 0,
      sub: d.isSidechain === true,
    }
    if (tools.length) turn.tools = tools
    const effort = d.perTurnEffort ?? d.effort
    if (typeof effort === 'string') turn.effort = effort
    const attr = ATTRIBUTION.filter(([k]) => typeof d[k] === 'string' && d[k]).map(([k, tag]) => `${tag}:${d[k]}`)
    if (attr.length) turn.attr = attr
    if (typeof d.thinkingDurationMs === 'number') turn.thinkMs = d.thinkingDurationMs
    if (d.isAbortedMidStream === true) turn.aborted = true
    if (id) byId.set(id, turn)
    out.turns.push(turn)
  }
  out.hits = [...hits.values()]
  return out
}

/** Hits of the same window seen in several transcripts: the first counts, retries add up. */
export function mergeHits(hits: Hit[]): Hit[] {
  const by = new Map<string, Hit>()
  for (const h of [...hits].sort((a, b) => a.t - b.t)) {
    const key = `${h.kind}|${h.r}`
    const cur = by.get(key)
    if (cur) cur.tries += h.tries
    else by.set(key, { ...h })
  }
  return [...by.values()]
}

/**
 * A hit is two exact readings: the window started at 0% and stood at 100% when
 * the request was refused. Calibration learns from them like from live ones.
 */
export function hitReadings(hits: Hit[]): Reading[] {
  return hits.flatMap(h => {
    const span = WINDOW_MS[h.kind]
    const end = Date.parse(h.r)
    if (!span || !Number.isFinite(end)) return []
    return [
      { t: end - span, kind: h.kind, p: 0, r: h.r },
      { t: h.t, kind: h.kind, p: 100, r: h.r },
    ]
  })
}

/**
 * Readings from all sessions, oldest first. Several sessions log the same move
 * of a window; the first to see each value is kept.
 */
export function dedupeReadings(rs: Reading[]): Reading[] {
  const seen = new Set<string>()
  return [...rs]
    .sort((a, b) => a.t - b.t)
    .filter(x => {
      const key = `${x.kind}|${x.r}|${x.p}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/**
 * Consecutive stretches between readings of one window, each at least
 * MIN_SPAN long. Readings are logged when a window moves a point, so both ends
 * sit close to a point boundary and the points moved are nearly exact.
 */
export function stretches(readings: Reading[], kind: string): [Reading, Reading][] {
  const byReset = new Map<string, Reading[]>()
  for (const x of readings) if (x.kind === kind) byReset.set(x.r ?? '', [...(byReset.get(x.r ?? '') ?? []), x])
  const out: [Reading, Reading][] = []
  const span = MIN_SPAN[kind] ?? HOUR
  for (const xs of byReset.values()) {
    xs.sort((a, b) => a.t - b.t)
    let start = xs[0]
    for (const x of xs.slice(1)) {
      if (!start || x.p < start.p) {
        start = x
        continue
      }
      if (x.t - start.t >= span) {
        out.push([start, x])
        start = x
      }
    }
  }
  return out
}

const decay = (age: number) => Math.pow(0.5, Math.max(0, age) / HALF_LIFE)

/**
 * Learns percent per unit for one window: each stretch's points moved against
 * the usage of all sessions in it, a weighted ratio estimate (recent stretches
 * count more). Stretches with points but no Claude Code usage were spent
 * elsewhere (claude.ai, another machine) and are left out.
 */
export function calibrate(readings: Reading[], between: Between, kind: string, now: number): Calib {
  const pairs = stretches(readings, kind)
    .filter(([, b]) => now - b.t <= LOOKBACK_DAYS * DAY)
    .map(([a, b]) => ({ y: b.p - a.p, x: between(a.t, b.t)[0], w: decay(now - b.t) }))
    .filter(p => p.x > 0)
  const points = pairs.reduce((a, p) => a + p.y, 0)
  const fit = ratioFit(pairs)
  const c: Calib = { kind, n: pairs.length, points }
  if (fit && points >= MIN_CALIB_POINTS) {
    c.k = fit.k
    if (fit.se !== undefined) c.se = fit.se
  }
  return c
}

/**
 * Checks the assumed Opus weight: fits the points moved against Opus and other
 * usage separately. 1 means Opus is weighted right; 1.3 means it costs 30% more
 * of the limit than assumed.
 */
export function weightCheck(readings: Reading[], between: Between, now: number) {
  const rows = stretches(readings, 'five_hour')
    .filter(([, b]) => now - b.t <= LOOKBACK_DAYS * DAY)
    .map(([a, b]) => {
      const [u, , opus] = between(a.t, b.t)
      return { y: b.p - a.p, x1: opus, x2: u - opus, w: decay(now - b.t) }
    })
  const r = ratioOfTwo(rows)
  return r && { ...r, n: rows.length }
}

const localDayStart = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const nextDay = (t: number) => {
  const d = new Date(t)
  d.setDate(d.getDate() + 1)
  return d.getTime()
}

export function hourOfWeek(t: number): number {
  const d = new Date(t)
  return d.getDay() * 24 + d.getHours()
}

const isWeekend = (t: number) => {
  const day = new Date(t).getDay()
  return day === 0 || day === 6
}

export type Profile = { perHour: number[]; days: number; since: number }

/**
 * Expected units per hour of the week. Factorized: a recency-weighted mean
 * total per weekday times one hour-of-day shape (smoothed over neighbouring
 * hours), 7 + 24 numbers instead of 168 sparse ones. Complete days only, idle
 * days included.
 */
export function profile(b: Buckets, now: number, weeks = 8): Profile {
  const since = firstBucket(b)
  const empty = { perHour: new Array(168).fill(0), days: 0, since: now }
  if (!Number.isFinite(since)) return empty
  const today = localDayStart(now)
  let day = localDayStart(Math.max(since, now - weeks * 7 * DAY))
  if (day < since) day = nextDay(day)
  const totals = new Map<number, number>()
  for (let d = day; d < today; d = nextDay(d)) totals.set(d, 0)
  const hours = new Array(24).fill(0)
  for (const [k, v] of Object.entries(b)) {
    const t = Number(k)
    if (t < day || t >= today) continue
    const d = localDayStart(t)
    totals.set(d, (totals.get(d) ?? 0) + v[0])
    hours[new Date(t).getHours()] += v[0] * decay(now - t)
  }

  const sumW = new Array(7).fill(0)
  const sumWT = new Array(7).fill(0)
  let allW = 0
  let allWT = 0
  for (const [d, total] of totals) {
    const w = decay(now - d)
    const dow = new Date(d).getDay()
    sumW[dow] += w
    sumWT[dow] += w * total
    allW += w
    allWT += w * total
  }
  const overall = allW > 0 ? allWT / allW : 0
  const dayMean = sumW.map((w, i) => (w > 0 ? sumWT[i] / w : overall))

  const smooth = hours.map((_, h) => 0.25 * hours[(h + 23) % 24] + 0.5 * hours[h] + 0.25 * hours[(h + 1) % 24])
  const total = smooth.reduce((a, x) => a + x, 0)
  const shape = smooth.map(x => (total > 0 ? x / total : 1 / 24))

  const perHour = new Array(168).fill(0).map((_, i) => (dayMean[Math.floor(i / 24)] ?? 0) * (shape[i % 24] ?? 0))
  return { perHour, days: (now - since) / DAY, since }
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

/**
 * The same stretch (now → end) in the past: earlier weeks for the weekly
 * window, earlier days of the same kind (workday or weekend) for the 5-hour one.
 */
export function pastStretches(between: Between, kind: string, now: number, end: number, since: number): number[] {
  const out: number[] = []
  if (kind === 'seven_day') {
    for (let i = 1; i <= 9; i++) {
      const s = now - i * 7 * DAY
      if (s < since) break
      out.push(between(s, end - i * 7 * DAY)[0])
    }
  } else {
    for (let d = 1; d <= 28 && out.length < 14; d++) {
      const s = now - d * DAY
      if (s < since) break
      if (isWeekend(s) === isWeekend(now)) out.push(between(s, end - d * DAY)[0])
    }
  }
  return out
}

/** Percent per hour from readings of one window: least-squares slope, if they span long enough. */
export function readingRate(readings: Reading[], kind: string, r: string | undefined, now: number, lookback: number) {
  const xs = readings.filter(x => x.kind === kind && x.r === r && x.t >= now - lookback && x.t <= now)
  if (xs.length < 3) return undefined
  const ts = xs.map(x => x.t)
  if (Math.max(...ts) - Math.min(...ts) < lookback / 4) return undefined
  const s = slope(ts, xs.map(x => x.p))
  return s === undefined ? undefined : Math.max(0, s * HOUR)
}

export type ForecastInput = {
  kind: string
  p: number
  resetsAt?: number
  r?: string
  now: number
  cal?: Pick<Calib, 'k' | 'se'>
  between: Between
  readings: Reading[]
  prof?: Profile
}

export function forecast(x: ForecastInput): Forecast {
  const L = WINDOW_MS[x.kind]
  const label = LABEL[x.kind] ?? x.kind
  const msToReset = x.resetsAt !== undefined ? Math.max(0, x.resetsAt - x.now) : undefined
  const isWeek = x.kind === 'seven_day'
  // The 5-hour window is judged on the last hour; the week on the last day,
  // since nobody works 24 hours straight.
  const lookback = isWeek ? DAY : HOUR
  const k = x.cal?.k

  let rate: number | undefined
  let rateBasis = 'not enough data yet'
  if (k !== undefined) {
    rate = (x.between(x.now - lookback, x.now)[0] * k) / (lookback / HOUR)
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
  const baseline = rate !== undefined && hoursToReset !== undefined ? x.p + rate * hoursToReset : undefined
  const msToLimit = rate !== undefined && rate > 0 ? ((100 - x.p) / rate) * HOUR : undefined

  let projected = baseline
  let lo: number | undefined
  let hi: number | undefined
  let risk: number | undefined
  let samples: number | undefined
  if (k !== undefined && x.prof && x.prof.days >= 3 && x.resetsAt !== undefined && hoursToReset !== undefined) {
    // Usual pattern until reset, plus today's deviation from it fading out
    // over TAU (mean reversion): a burst does not last until the reset.
    const lbH = lookback / HOUR
    const tauH = (TAU[x.kind] ?? HOUR) / HOUR
    const usual = expectedUnits(x.prof.perHour, x.now, x.resetsAt)
    const now = x.between(x.now - lookback, x.now)[0] / lbH
    const then = expectedUnits(x.prof.perHour, x.now - lookback, x.now) / lbH
    const base = Math.max(0, usual + (now - then) * tauH * (1 - Math.exp(-hoursToReset / tauH)))
    projected = x.p + k * base

    // Spread: how the same stretch varied in the past (empirical residuals),
    // combined in quadrature with the uncertainty of k.
    const past = pastStretches(x.between, x.kind, x.now, x.resetsAt, x.prof.since)
    if (past.length >= 3) {
      const m = mean(past)
      const sims = past.map(u => x.p + k * Math.max(0, base + u - m))
      const kErr = Z80 * (x.cal?.se ?? 0) * base
      lo = Math.max(x.p, projected - Math.hypot(Math.max(0, projected - quantile(sims, 0.1)), kErr))
      hi = projected + Math.hypot(Math.max(0, quantile(sims, 0.9) - projected), kErr)
      risk = sims.filter(s => s >= 100).length / sims.length
      samples = past.length
    }
  }

  const perDayLeft = isWeek && msToReset !== undefined && msToReset > 0
    ? Math.max(0, 100 - x.p) / Math.max(msToReset / DAY, 1 / 24)
    : undefined

  // Hard data (the limit itself, or the current speed hitting it soon) can say
  // "hold on"; a forecast from the usual pattern only ever says "slow down".
  const near = isWeek ? DAY : 45 * MINUTE
  const runsOutSoon = msToLimit !== undefined && msToReset !== undefined && msToLimit < msToReset && msToLimit < near
  const forecastOver = risk !== undefined ? risk > 0.5 : projected !== undefined && projected > 100
  let verdict: Verdict = 'ok'
  if (x.p >= 95 || runsOutSoon) verdict = 'hold'
  else if (forecastOver || x.p >= 85) verdict = 'slow'

  const unit = isWeek ? 'weeks' : 'days'
  const range = lo !== undefined && hi !== undefined ? ` (80%: ${fmtRange(lo, hi)})` : ''
  let headline: string
  if (x.p >= 95) headline = `${label} limit almost used (${fmtPct(x.p)}).`
  else if (runsOutSoon) headline = `${label}: at this speed you hit the limit in ~${dur(msToLimit!)}, reset is in ${dur(msToReset!)}.`
  else if (risk !== undefined && risk > 0.5) headline = `${label}: ${fmtPct(risk * 100)} risk of running out before the reset in ${dur(msToReset!)} (compared with ${samples} past ${unit}).`
  else if (projected !== undefined && projected > 100 && msToLimit !== undefined && msToReset !== undefined) headline = `${label}: at this speed you hit the limit in ~${dur(msToLimit)}, reset is in ${dur(msToReset)}.`
  else if (projected !== undefined && msToReset !== undefined) headline = `${label}: on track for ~${fmtPct(Math.min(projected, 100))}${range} at reset in ${dur(msToReset)}.`
  else if (msToReset !== undefined) headline = `${label}: ${fmtPct(x.p)} used, reset in ${dur(msToReset)}.`
  else headline = `${label}: ${fmtPct(x.p)} used.`

  const f: Forecast = { kind: x.kind, label, p: x.p, rateBasis, verdict, headline }
  Object.assign(f, strip({ msToReset, rate, msToLimit, projected, lo, hi, risk, samples, baseline, pace, perDayLeft }))
  if (samples !== undefined) f.sampleUnit = unit
  return f
}

const strip = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

/** The forecast to log for scoring later, or undefined when there is none. */
export function toLog(f: Forecast, t: number, r: string | undefined): ForecastLog | undefined {
  if (f.projected === undefined || !r) return undefined
  const round = (v?: number) => (v === undefined ? undefined : Math.round(v * 10) / 10)
  return strip({ t, kind: f.kind, r, p: f.p, pt: round(f.projected)!, lo: round(f.lo), hi: round(f.hi), risk: round(f.risk), n: f.samples, b: round(f.baseline) }) as ForecastLog
}

export type Quality = {
  kind: string
  /** Forecasts scored (windows that have reset). */
  n: number
  /** Mean absolute error of the point forecast, in percent points. */
  mae?: number
  /** Mean error: positive means forecasts ran high. */
  bias?: number
  /** Share of outcomes inside the 80% interval: honest intervals hit about 80%. */
  coverage?: number
  nInterval: number
  /** Mean width of the 80% interval (sharpness), in points. */
  width?: number
  /** Brier score of the risk of running out: 0 is perfect, 0.25 a coin toss. */
  brier?: number
  nRisk: number
  /** 1 − MAE / MAE of the constant-speed baseline: above 0 beats it. */
  skill?: number
}

/**
 * Scores logged forecasts against what happened: the final percent of each
 * window that has reset. Several sessions may log the same forecast, so one
 * per window and hour counts.
 */
export function evaluate(logs: ForecastLog[], readings: Reading[], kind: string, now: number, since = now - LOOKBACK_DAYS * DAY): Quality {
  const final = new Map<string, { p: number; t: number }>()
  for (const x of readings) {
    if (x.kind !== kind || !x.r) continue
    const cur = final.get(x.r)
    final.set(x.r, { p: Math.max(cur?.p ?? 0, x.p), t: Math.max(cur?.t ?? 0, x.t) })
  }
  const seen = new Set<string>()
  const scored: { f: ForecastLog; y: number }[] = []
  for (const f of [...logs].sort((a, b) => a.t - b.t)) {
    if (f.kind !== kind || f.t < since || !(Date.parse(f.r) <= now)) continue
    const out = final.get(f.r)
    const key = `${f.r}|${Math.floor(f.t / HOUR)}`
    if (!out || out.t < f.t || seen.has(key)) continue
    seen.add(key)
    scored.push({ f, y: Math.min(out.p, 100) })
  }
  const q: Quality = { kind, n: scored.length, nInterval: 0, nRisk: 0 }
  if (scored.length === 0) return q
  const err = scored.map(s => Math.min(s.f.pt, 100) - s.y)
  q.mae = mean(err.map(Math.abs))
  q.bias = mean(err)
  const iv = scored.filter(s => s.f.lo !== undefined && s.f.hi !== undefined)
  q.nInterval = iv.length
  if (iv.length) {
    q.coverage = iv.filter(s => s.y >= s.f.lo! - 0.5 && s.y <= Math.min(s.f.hi!, 100) + 0.5).length / iv.length
    q.width = mean(iv.map(s => Math.min(s.f.hi!, 100) - s.f.lo!))
  }
  const rk = scored.filter(s => s.f.risk !== undefined)
  q.nRisk = rk.length
  if (rk.length) q.brier = mean(rk.map(s => (s.f.risk! - (s.y >= 99.5 ? 1 : 0)) ** 2))
  const bl = scored.filter(s => s.f.b !== undefined)
  const blErr = bl.reduce((a, s) => a + Math.abs(Math.min(s.f.b!, 100) - s.y), 0)
  if (bl.length && blErr > 0) {
    q.skill = 1 - bl.reduce((a, s) => a + Math.abs(Math.min(s.f.pt, 100) - s.y), 0) / blErr
  }
  return q
}

/** How regular weekly usage is: coefficient of variation of complete past weeks. */
export function regularity(between: Between, now: number, since: number) {
  const weeks: number[] = []
  for (let i = 1; i <= 8; i++) {
    const s = now - i * 7 * DAY
    if (s < since) break
    weeks.push(between(s, s + 7 * DAY)[0])
  }
  const c = cv(weeks)
  return c === undefined ? undefined : { cv: c, weeks: weeks.length }
}

export type SuggestionInput = {
  forecasts: Forecast[]
  between: Between
  now: number
  /** Context size of the main thread, in tokens. */
  context?: number
}

export function suggestions(x: SuggestionInput): Tip[] {
  const out: Tip[] = []
  const short = x.forecasts.find(f => f.kind === 'five_hour')
  const week = x.forecasts.find(f => f.kind === 'seven_day')
  // Tight: not OK, or OK but the forecast or risk says it is close.
  const tight = (f?: Forecast) => !!f && (f.verdict !== 'ok' || (f.projected ?? 0) >= 100 || (f.risk ?? 0) >= 0.5)
  const anyPressure = x.forecasts.some(f => tight(f))
  const [total, sub, opus] = x.between(x.now - 5 * HOUR, x.now)

  if (anyPressure) {
    if ((x.context ?? 0) > 120_000) {
      out.push({ id: 'context', text: `Your context is ~${Math.round((x.context ?? 0) / 1000)}k tokens and every message re-sends it: /compact, or /clear when you switch topics.` })
    }
    if (total > 0 && opus / total > 0.6) {
      out.push({ id: 'model', text: 'Most recent usage is Opus. Sonnet for routine work (/model) makes the same limit last about 1.7× longer.' })
    }
    if (total > 0 && sub / total > 0.4) {
      out.push({ id: 'subagents', text: `Subagents made ${Math.round((sub / total) * 100)}% of recent usage: fewer parallel agents slow the burn most.` })
    }
    if (short && tight(short) && short.msToReset !== undefined && !tight(week)) {
      out.push({ id: 'break', text: `The 5-hour window resets in ${dur(short.msToReset)}: a break until then costs nothing from the week.` })
    }
    if (week && tight(week) && week.perDayLeft !== undefined) {
      out.push({ id: 'budget', text: `To last the week, keep to about ${fmtPct(week.perDayLeft)} per day until the reset.` })
    }
  } else if (
    week && week.pace !== undefined && week.p < week.pace - 10 && week.perDayLeft !== undefined &&
    (week.projected ?? 0) < 90 && (week.risk ?? 0) < 0.25
  ) {
    out.push({ id: 'room', text: `You're ${Math.round(week.pace - week.p)} points under an even pace this week: about ${fmtPct(week.perDayLeft)} per day is available, room for bigger tasks.` })
  }
  return out
}

/** Estimated weekly percent of the past weeks, from the current reset backwards. */
export function pastWeeks(between: Between, resetsAt: number, k: number, since: number, count = 4): number[] {
  const res: number[] = []
  for (let i = 1; i <= count; i++) {
    const end = resetsAt - i * 7 * DAY
    if (end - 7 * DAY < since) break
    res.push(between(end - 7 * DAY, end)[0] * k)
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

export const fmtRange = (lo: number, hi: number) => `${Math.round(lo)}–${fmtPct(hi)}`

export function dur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}`
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h / 24}d`
}

/**
 * The limits line as plain text: the same fields for every window, OK or not,
 * in the same order, then when Claude Code last reported them. A dash stands
 * for what is not known yet.
 *   5h 42% ↻ 2h30 → 68% (61–77) risk 0% ● OK   │   wk 61% ↻ 3d → 104% (88–119) risk 75% ● SLOW DOWN   · 14:02
 */
export function statusText(forecasts: Forecast[], at?: number): string | undefined {
  if (forecasts.length === 0) return undefined
  const parts = forecasts.map(f => {
    const s = statusParts(f)
    return `${s.name} ${s.pct} ↻ ${s.reset} → ${s.ahead}${s.range ? ` (${s.range})` : ''} risk ${s.risk} ● ${s.verdict}`
  })
  return parts.join('   │   ') + (at === undefined ? '' : `   · ${hhmm(at)}`)
}

/**
 * One window's fields, apart so they can be drawn in their own colors. `tone`
 * colors the forecast: bad over 100%, warn when it is near or its range
 * reaches past the limit.
 */
export function statusParts(f: Forecast) {
  const tone: 'good' | 'warn' | 'bad' | undefined = f.projected === undefined
    ? undefined
    : f.projected > 100 ? 'bad' : f.projected >= 90 || (f.hi ?? 0) > 100 ? 'warn' : 'good'
  return {
    name: SHORT[f.kind] ?? f.kind,
    pct: fmtPct(f.p),
    reset: f.msToReset === undefined ? '–' : dur(f.msToReset),
    ahead: f.projected === undefined ? '–' : fmtPct(f.projected),
    range: f.lo !== undefined && f.hi !== undefined ? `${Math.round(f.lo)}–${Math.round(f.hi)}` : undefined,
    risk: f.risk === undefined ? '–' : fmtPct(f.risk * 100),
    verdict: VERDICT_TEXT[f.verdict],
    tone,
  }
}

/** Local clock time, `14:02`. */
export const hhmm = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export type BarPart = { kind: 'used' | 'likely' | 'range' | 'free' | 'limit'; text: string }

/**
 * A bar from 0 to 125% (25 cells of 5% by default) with the limit marked at
 * 100%: what is used, what the forecast adds by the reset, and the 80% range
 * above the forecast.
 */
export function rangeBar(f: Pick<Forecast, 'p' | 'projected' | 'hi'>, cells = 25): BarPart[] {
  const CH = { used: '█', likely: '▓', range: '▒', free: '·', limit: '│' } as const
  // ▓ up to the forecast, ▒ from there to the top of the range: the side
  // that decides whether the limit is reached (a fan chart in one row).
  const likelyTo = f.projected ?? f.p
  const rangeTo = f.hi ?? f.projected ?? f.p
  const parts: BarPart[] = []
  const push = (kind: BarPart['kind']) => {
    const last = parts[parts.length - 1]
    if (last && last.kind === kind) last.text += CH[kind]
    else parts.push({ kind, text: CH[kind] })
  }
  const step = 125 / cells
  for (let i = 0; i < cells; i++) {
    if (i === Math.round(cells * 0.8)) push('limit')
    const mid = (i + 0.5) * step
    push(mid < f.p ? 'used' : mid < likelyTo ? 'likely' : mid < rangeTo ? 'range' : 'free')
  }
  return parts
}
