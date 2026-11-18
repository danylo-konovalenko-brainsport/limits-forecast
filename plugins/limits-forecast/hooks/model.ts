// Pure logic of the limits mod: no `$`, no I/O, so it can be tested directly.

import { cv, kdeQuantile, kdeTail, mean, ratioFit, ratioOfTwo, slope } from './stats'

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
  /** Of `cw`, the tokens written to the 1-hour cache (2× input) rather than the 5-minute one (1.25×). */
  cw1h?: number
  sub?: boolean
  /** Transcripts only: tool names the message called, effort level, what it is attributed to. */
  tools?: string[]
  effort?: string
  /** `skill:x`, `plugin:x`, `mcp:server`, `agent:type`. */
  attr?: string[]
  thinkMs?: number
  aborted?: boolean
}

/** Usage in one bucket or stretch: [units, subagent units, Opus units, Fable units]. */
export type Cells = [number, number, number, number]
/** Usage summed per 15 minutes. */
export type Buckets = Record<string, Cells>
/** Usage between two times, edge buckets prorated. */
export type Between = (from: number, to: number) => Cells

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
  /** `se` is an assumed ±25%, not yet measured (fewer than 3 stretches). */
  seAssumed?: boolean
  /** Re-learned from recent stretches only after a change from this time on. */
  changedAt?: number
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
  /** The correction the forecast was scaled by (1 when absent), so scoring can undo it. */
  c?: number
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
  /** The scored-bias correction applied to k, when not 1. */
  correction?: number
  /** A model's own window: how much of the shared weekly limit the model may take and has taken. */
  share?: Share
  verdict: Verdict
  headline: string
}

export type Tip = { id: string; text: string }

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const BUCKET = 15 * MINUTE
export const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY }
const LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly' }
const SHORT: Record<string, string> = { five_hour: '5h', seven_day: 'wk' }

/** The weekly windows: the shared one and each model's own (`seven_day_fable`). */
export const isWeekly = (kind: string) => kind === 'seven_day' || kind.startsWith('seven_day_')
/** The model a weekly window of its own counts, `fable` for `seven_day_fable`; undefined for the shared windows. */
export const scopeOf = (kind: string) => (kind.startsWith('seven_day_') ? kind.slice('seven_day_'.length) : undefined)
/** The shared window a kind runs like: its length and time constants. */
const baseKind = (kind: string) => (isWeekly(kind) ? 'seven_day' : kind)
/** A window's name in the pane (`Weekly`, `Fable`) and in the limits line (`wk`, `fable`). */
export function labelOf(kind: string): string {
  const scope = scopeOf(kind)?.replace(/_/g, ' ')
  return LABEL[kind] ?? (scope ? scope.charAt(0).toUpperCase() + scope.slice(1) : kind)
}
export const shortOf = (kind: string) => SHORT[kind] ?? scopeOf(kind) ?? kind

export const VERDICT_TEXT: Record<Verdict, string> = { ok: 'OK', slow: 'SLOW DOWN', hold: 'HOLD ON' }

/** Calibration counts as usable once this many percent points were matched. */
export const MIN_CALIB_POINTS = 3
/** Relative error of k assumed until 3 stretches give a measured one. */
export const ASSUMED_REL_SE = 0.25
/** Evidence older than this halves in weight. */
const HALF_LIFE = 14 * DAY
/** Calibration and scoring look back this far. */
export const LOOKBACK_DAYS = 28
/** Shortest stretch between two readings that is matched to usage. */
const MIN_SPAN: Record<string, number> = { five_hour: HOUR, seven_day: 12 * HOUR }
/** How long a deviation from the usual pattern is expected to last. */
const TAU: Record<string, number> = { five_hour: HOUR, seven_day: 12 * HOUR }

const VERDICT_RANK: Record<Verdict, number> = { ok: 0, slow: 1, hold: 2 }

export const worst = (vs: Verdict[]): Verdict =>
  vs.reduce<Verdict>((a, v) => (VERDICT_RANK[v] > VERDICT_RANK[a] ? v : a), 'ok')

export const isWorse = (a: Verdict, b: Verdict) => VERDICT_RANK[a] > VERDICT_RANK[b]

/**
 * API list prices by family and generation: input $/MTok and cache reads as a
 * share of input. Unknown models count as the current Sonnet.
 */
const PRICES: [RegExp, number, number][] = [
  [/fable|mythos/, 10, 0.025],
  [/opus-5-5/, 4, 0.05],
  [/opus-4-(1-)?2025/, 15, 0.1],
  [/opus/, 5, 0.1],
  [/sonnet-5/, 2, 0.1],
  [/sonnet/, 3, 0.1],
  [/haiku-5/, 0.1, 0.1],
  [/haiku/, 1, 0.1],
]

export function price(model: string): { input: number; cacheRead: number } {
  const m = model.toLowerCase()
  const row = PRICES.find(([re]) => re.test(m))
  return row ? { input: row[1], cacheRead: row[2] } : { input: 2, cacheRead: 0.1 }
}

/** The model families whose weight against the limit the mod checks on its own. */
export type Family = 'opus' | 'fable'
export const FAMILIES: Family[] = ['opus', 'fable']
export const FAMILY_LABEL: Record<Family, string> = { opus: 'Opus', fable: 'Fable' }
/** Where each family's usage sits in a bucket. */
export const FAMILY_CELL: Record<Family, 2 | 3> = { opus: 2, fable: 3 }

export function family(model: string): Family | 'other' {
  const m = model.toLowerCase()
  return /fable|mythos/.test(m) ? 'fable' : m.includes('opus') ? 'opus' : 'other'
}

/**
 * A turn's cost in "units": tokens weighted like API list prices (cache reads
 * are cheap, output is expensive, Fable costs more). One unit is about one US
 * dollar at those prices.
 */
export function units(t: Pick<Turn, 'model' | 'in' | 'cw' | 'cr' | 'out' | 'cw1h'>): number {
  const { input, cacheRead } = price(t.model)
  const cw1h = t.cw1h ?? 0
  return (input * (t.in + 1.25 * (t.cw - cw1h) + 2 * cw1h + cacheRead * t.cr + 5 * t.out)) / 1e6
}

export const bucketKey = (t: number) => String(Math.floor(t / BUCKET) * BUCKET)

const ZERO: Cells = [0, 0, 0, 0]
const plus = (a: Cells, b: Cells): Cells => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]]

export function addToBuckets(b: Buckets, turn: Turn) {
  const k = bucketKey(turn.t)
  const u = units(turn)
  const fam = family(turn.model)
  b[k] = plus(b[k] ?? ZERO, [u, turn.sub ? u : 0, fam === 'opus' ? u : 0, fam === 'fable' ? u : 0])
}

/**
 * The buckets as a model's own window counts them: that family's usage alone
 * (its subagent share is not kept apart). A model the mod keeps no cell for
 * gives none, and its window is forecast from its readings.
 */
export function familyBuckets(b: Buckets, fam: Family | 'other'): Buckets {
  if (fam === 'other') return {}
  const cell = FAMILY_CELL[fam]
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, [v[cell], 0, 0, 0]]))
}

export function mergeBuckets(into: Buckets, from: Buckets) {
  for (const [k, v] of Object.entries(from)) into[k] = plus(into[k] ?? ZERO, v)
}

/** Prefix sums over the buckets, so any range sums in O(log n). */
export function usageIndex(b: Buckets): Between {
  const ks = Object.keys(b).map(Number).sort((x, y) => x - y)
  const vs = ks.map(k => b[String(k)]!)
  const cum: Cells[] = [ZERO]
  for (const v of vs) cum.push(plus(cum[cum.length - 1]!, v))
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
    if (!(to > from)) return [0, 0, 0, 0]
    const i0 = lower(from - BUCKET + 1)
    const i1 = lower(to)
    if (i1 <= i0) return [0, 0, 0, 0]
    const a = cum[i0]!
    const z = cum[i1]!
    const res: Cells = [z[0] - a[0], z[1] - a[1], z[2] - a[2], z[3] - a[3]]
    for (const i of i1 - 1 === i0 ? [i0] : [i0, i1 - 1]) {
      const start = ks[i]!
      const outside = 1 - (Math.min(start + BUCKET, to) - Math.max(start, from)) / BUCKET
      const v = vs[i]!
      for (let j = 0; j < 4; j++) res[j]! -= v[j]! * outside
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
    const cw1h = u.cache_creation?.ephemeral_1h_input_tokens
    if (typeof cw1h === 'number' && cw1h > 0) turn.cw1h = Math.min(cw1h, turn.cw)
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

/** How much of the shared weekly limit a model may take and has taken, in percent of it. */
export type Share = { used: number; allowance: number }
/** A limit window as Claude Code reports the shared ones, plus what only a model's own has. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string; share?: Share }

/**
 * The per-model weekly windows in the answer of Anthropic's usage endpoint,
 * what /usage shows as "Current week (Fable)": the `limits` rows of kind
 * `weekly_scoped`, named by `scope.model.display_name`, with their place in
 * `weekly_scoped_shares`. The reset is rounded to the minute: the endpoint's
 * carries microseconds, and readings of one window are grouped by it. A shape
 * it does not know gives none.
 */
export function scopedLimits(body: unknown): Limit[] {
  const b = body as any
  if (!Array.isArray(b?.limits)) return []
  const shares: any[] = Array.isArray(b.weekly_scoped_shares) ? b.weekly_scoped_shares : []
  return b.limits.flatMap((l: any, i: number): Limit[] => {
    const name = l?.scope?.model?.display_name
    if (l?.kind !== 'weekly_scoped' || typeof name !== 'string' || typeof l.percent !== 'number' || !Number.isFinite(l.percent)) return []
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    if (!slug) return []
    const t = typeof l.resets_at === 'number' ? l.resets_at * 1000 : Date.parse(String(l.resets_at).replace(/(\.\d{3})\d+/, '$1'))
    const s = shares.find(x => x?.limit_index === i)
    const limit: Limit = { kind: `seven_day_${slug}`, percentUsed: Math.round(l.percent * 10) / 10 }
    if (Number.isFinite(t)) limit.resetsAt = new Date(Math.round(t / MINUTE) * MINUTE).toISOString()
    if (typeof s?.used_percent_of_weekly === 'number' && typeof s.allowance_percent_of_weekly === 'number') {
      limit.share = { used: s.used_percent_of_weekly, allowance: s.allowance_percent_of_weekly }
    }
    return [limit]
  })
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
    const span = WINDOW_MS[baseKind(h.kind)]
    const end = Date.parse(h.r)
    if (!span || !Number.isFinite(end)) return []
    return [
      { t: end - span, kind: h.kind, p: 0, r: h.r },
      { t: h.t, kind: h.kind, p: 100, r: h.r },
    ]
  })
}

/**
 * A model's own window is first read somewhere in its middle, but it began at
 * 0% a week before its reset. That start is a reading too, so the first read
 * already teaches tokens → % from the model's usage since the window began.
 */
export function startReadings(readings: Reading[]): Reading[] {
  const out = new Map<string, Reading>()
  for (const x of readings) {
    const end = x.r ? Date.parse(x.r) : NaN
    const span = WINDOW_MS[baseKind(x.kind)]
    if (scopeOf(x.kind) === undefined || !span || !Number.isFinite(end)) continue
    out.set(`${x.kind}|${x.r}`, { t: end - span, kind: x.kind, p: 0, r: x.r })
  }
  return [...out.values()]
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
  const span = MIN_SPAN[baseKind(kind)] ?? HOUR
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

const decay = (age: number, halfLife = HALF_LIFE) => Math.pow(0.5, Math.max(0, age) / halfLife)

/**
 * Learns percent per unit for one window: each stretch's points moved against
 * the usage of all sessions in it, a weighted ratio estimate (recent stretches
 * count more). Stretches with points but no Claude Code usage were spent
 * elsewhere (claude.ai, another machine) and are left out.
 */
export function calibrate(readings: Reading[], between: Between, kind: string, now: number): Calib {
  let pairs = stretches(readings, kind)
    .filter(([, b]) => now - b.t <= LOOKBACK_DAYS * DAY)
    .map(([a, b]) => ({ t: a.t, y: b.p - a.p, x: between(a.t, b.t)[0], w: decay(now - b.t) }))
    .filter(p => p.x > 0)
    .sort((a, b) => a.t - b.t)
  let fit = ratioFit(pairs)
  let changedAt: number | undefined
  // A change (a new plan, new limits): the two latest stretches both far off
  // the fit on the same side. Learn from them alone instead of waiting weeks
  // for the old ones to fade. Small stretches are coarse (whole points), so
  // they need a bigger miss.
  if (fit && pairs.length >= 4) {
    const k = fit.k
    const last = pairs.slice(-2)
    const off = last.map(p => p.y / (k * p.x) - 1)
    const tol = last.map(p => Math.max(0.3, (3 * (fit?.se ?? 0)) / k, 2 / p.y))
    if (off.every((o, i) => o > tol[i]!) || off.every((o, i) => o < -tol[i]!)) {
      pairs = last
      fit = ratioFit(pairs)
      changedAt = last[0]!.t
    }
  }
  const points = pairs.reduce((a, p) => a + p.y, 0)
  const c: Calib = { kind, n: pairs.length, points }
  if (changedAt !== undefined) c.changedAt = changedAt
  if (fit && points >= MIN_CALIB_POINTS) {
    c.k = fit.k
    // Until 3 stretches give a measured error, assume one rather than none:
    // a range that treats k as exact is overconfident.
    if (fit.se !== undefined) c.se = fit.se
    else {
      c.se = fit.k * ASSUMED_REL_SE
      c.seAssumed = true
    }
  }
  return c
}

/**
 * Checks a family's assumed weight: fits the points moved against that
 * family's usage and all other usage separately. 1 means it is weighted
 * right; 1.3 means it costs 30% more of the limit than assumed.
 */
export function weightCheck(readings: Reading[], between: Between, now: number, fam: Family = 'opus') {
  const cell = FAMILY_CELL[fam]
  const rows = stretches(readings, 'five_hour')
    .filter(([, b]) => now - b.t <= LOOKBACK_DAYS * DAY)
    .map(([a, b]) => {
      const u = between(a.t, b.t)
      return { y: b.p - a.p, x1: u[cell], x2: u[0] - u[cell], w: decay(now - b.t) }
    })
  const r = ratioOfTwo(rows)
  return r && { ...r, n: rows.length }
}

/**
 * The checked weight once it clearly differs from the assumed one (more than
 * 2 standard errors away from 1, and measured to within 25%); else 1.
 */
export function familyWeight(check?: { ratio: number; se: number }): number {
  if (!check || check.se > 0.25 * check.ratio || Math.abs(check.ratio - 1) <= 2 * check.se) return 1
  return check.ratio
}

/** Buckets with each family's usage counted that many times as heavy. */
export function reweight(b: Buckets, w: Record<Family, number>): Buckets {
  if (w.opus === 1 && w.fable === 1) return b
  return Object.fromEntries(Object.entries(b).map(([k, [u, s, o, f]]) => [k, [u + (w.opus - 1) * o + (w.fable - 1) * f, s, o * w.opus, f * w.fable]]))
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

export type Profile = { perHour: number[]; days: number; since: number; halfLife: number }

/**
 * Expected units per hour of the week. Factorized: a recency-weighted mean
 * total per weekday times one hour-of-day shape (smoothed over neighbouring
 * hours), 7 + 24 numbers instead of 168 sparse ones. Complete days only, idle
 * days included.
 */
export function profile(b: Buckets, now: number, weeks = 8, halfLife = HALF_LIFE): Profile {
  const since = firstBucket(b)
  const empty = { perHour: new Array(168).fill(0), days: 0, since: now, halfLife }
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
    hours[new Date(t).getHours()] += v[0] * decay(now - t, halfLife)
  }

  const sumW = new Array(7).fill(0)
  const sumWT = new Array(7).fill(0)
  let allW = 0
  let allWT = 0
  for (const [d, total] of totals) {
    const w = decay(now - d, halfLife)
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
  return { perHour, days: (now - since) / DAY, since, halfLife }
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
  if (isWeekly(kind)) {
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
  tune?: Tuning
  /** The verdict this window had last time, so it does not flap around the risk threshold. */
  prev?: Verdict
  /** The scored-bias correction for k (`correction`), 1 when none. */
  correction?: number
  /** A model's own window: its place in the shared weekly limit, handed on as it is. */
  share?: Share
}

/**
 * Expected usage (units) from `now` to `end`: the usual pattern, plus the
 * recent deviation from it fading out over `tau` (mean reversion), since a
 * burst does not last until the reset. The deviation is measured over the
 * last hour (5-hour window) or day (week).
 */
export function expectedBase(prof: Profile, between: Between, kind: string, now: number, end: number, tau = TAU[baseKind(kind)] ?? HOUR): number {
  const lookback = isWeekly(kind) ? DAY : HOUR
  const lbH = lookback / HOUR
  const tauH = tau / HOUR
  const usual = expectedUnits(prof.perHour, now, end)
  const current = between(now - lookback, now)[0] / lbH
  const usualThen = expectedUnits(prof.perHour, now - lookback, now) / lbH
  return Math.max(0, usual + (current - usualThen) * tauH * (1 - Math.exp(-(end - now) / HOUR / tauH)))
}

/** One outcome (units) per past stretch: the forecast plus that stretch's deviation from normal, scaled. */
export function scenarios(base: number, past: number[], scale = 1): number[] {
  const m = mean(past)
  return past.map(u => Math.max(0, base + scale * (u - m)))
}

/** Forecast settings, tuned by replaying past weeks. */
export type Tuning = {
  /** How long a deviation from the usual pattern lasts. */
  tau: number
  /** Recency half-life of the weekly profile. */
  halfLife: number
  /** Width of the range relative to the past spread. */
  scale: number
  /** Forecasts are multiplied by this: replayed actual ÷ forecast. */
  bias: number
  /** Replayed forecasts. */
  n: number
  /** Of those, about how many do not overlap: the time they span ÷ the horizon. */
  independent: number
  /** How much smaller the point error got than with the defaults: 0.12 = 12%. */
  gain?: number
  /** Share of replayed outcomes inside the 80% range, with the default width and with the tuned one. */
  coverage0?: number
  coverage?: number
}

export const defaultTuning = (kind: string): Tuning => ({ tau: TAU[baseKind(kind)] ?? HOUR, halfLife: HALF_LIFE, scale: 1, bias: 1, n: 0, independent: 0 })

/**
 * Non-overlapping replayed forecasts needed before tuned settings are used.
 * Replayed moments a few hours apart share most of their future, so they
 * count as one.
 */
export const MIN_REPLAY = 10

/**
 * Learns the forecast settings by replaying the past: at many past moments,
 * forecasts the usage until `horizon` later from what was known then (rolling
 * origin), and compares with what happened. In usage units, so no past limit
 * readings are needed. Picks the fade-out time and profile half-life with the
 * smallest error, then the bias, then the range width that held 80% of
 * outcomes. A setting only replaces its default when it is clearly better.
 */
export function tune(b: Buckets, kind: string, now: number, horizon: number): Tuning {
  const t0 = defaultTuning(kind)
  const between = usageIndex(b)
  const since = firstBucket(b)
  if (!Number.isFinite(since) || !(horizon > 0)) return t0
  const isWeek = isWeekly(kind)
  const step = isWeek ? 6 * HOUR : 2 * HOUR
  const taus = (isWeek ? [3, 12, 24, 48] : [0.25, 1, 2, 4]).map(h => h * HOUR)
  const lives = [7, 14, 28].map(d => d * DAY)

  const cases: { o: number; actual: number; past: number[]; base: number[][] }[] = []
  const start = Math.max(since + (isWeek ? 21 : 3) * DAY, now - (isWeek ? 63 : LOOKBACK_DAYS) * DAY)
  for (let o = Math.ceil(start / step) * step; o + horizon <= now; o += step) {
    const end = o + horizon
    const past = pastStretches(between, kind, o, end, since)
    if (past.length < 3) continue
    const actual = between(o, end)[0]
    const base = lives.map(hl => {
      const prof = profile(b, o, 8, hl)
      return taus.map(tau => expectedBase(prof, between, kind, o, end, tau))
    })
    // Idle and expected idle: says nothing about the settings.
    if (actual === 0 && base.every(row => row.every(x => x === 0))) continue
    cases.push({ o, actual, past, base })
  }
  const n = cases.length
  const independent = n && Math.min(n, Math.floor((cases[n - 1]!.o - cases[0]!.o) / horizon) + 1)
  if (independent < MIN_REPLAY) return { ...t0, n, independent }

  const mae = (li: number, ti: number) => mean(cases.map(c => Math.abs(c.base[li]![ti]! - c.actual)))
  const def: [number, number] = [lives.indexOf(HALF_LIFE), taus.indexOf(t0.tau)]
  const defErr = mae(...def)
  let best = def
  let bestErr = defErr
  for (let li = 0; li < lives.length; li++) {
    for (let ti = 0; ti < taus.length; ti++) {
      const e = mae(li, ti)
      if (e < bestErr) [best, bestErr] = [[li, ti], e]
    }
  }
  // ponytail: a fixed 5% margin stands in for a significance test (Diebold-Mariano);
  // replayed moments overlap, so a small gain over a few weeks is easily noise.
  if (bestErr > 0.95 * defErr) [best, bestErr] = [def, defErr]
  const [li, ti] = best

  const sumF = cases.reduce((a, c) => a + c.base[li]![ti]!, 0)
  const ratio = sumF > 0 ? clamp(cases.reduce((a, c) => a + c.actual, 0) / sumF, 0.67, 1.5) : 1
  const bias = Math.abs(ratio - 1) < 0.05 ? 1 : ratio

  const cover = (scale: number) =>
    mean(cases.map(c => {
      const s = scenarios(c.base[li]![ti]! * bias, c.past, scale)
      return c.actual >= kdeQuantile(s, 0.1) && c.actual <= kdeQuantile(s, 0.9) ? 1 : 0
    }))
  // Nearest to 1 first, so a tie keeps the width closer to the past spread.
  const scales = [1, 1.25, 0.75, 1.5, 2, 0.5, 2.5, 3, 4]
  const covs = scales.map(cover)
  let si = 0
  for (let i = 1; i < scales.length; i++) if (Math.abs(covs[i]! - 0.8) < Math.abs(covs[si]! - 0.8)) si = i

  return {
    tau: taus[ti]!,
    halfLife: lives[li]!,
    scale: scales[si]!,
    bias,
    n,
    independent,
    gain: defErr > 0 ? 1 - bestErr / defErr : 0,
    coverage0: covs[0]!,
    coverage: covs[si]!,
  }
}

/** Whether the current speed reaches the limit before the reset and soon: 45 min for the 5-hour window, 6 h for the week. */
export function runsOutSoon(kind: string, msToLimit?: number, msToReset?: number): boolean {
  const near = isWeekly(kind) ? 6 * HOUR : 45 * MINUTE
  return msToLimit !== undefined && msToReset !== undefined && msToLimit < msToReset && msToLimit < near
}

export type VerdictInput = { kind: string; p: number; risk?: number; projected?: number; msToLimit?: number; msToReset?: number; prev?: Verdict }

/**
 * Hard data (the limit itself, or the current speed hitting it soon) can say
 * "hold on"; a forecast from the usual pattern only ever says "slow down".
 * That starts above 55% risk and holds until the risk is under 45%, so the
 * verdict does not flap around one number.
 */
export function verdictFor(x: VerdictInput): Verdict {
  if (x.p >= 95 || runsOutSoon(x.kind, x.msToLimit, x.msToReset)) return 'hold'
  const wasOver = x.prev === 'slow' || x.prev === 'hold'
  const forecastOver = x.risk !== undefined ? x.risk > (wasOver ? 0.45 : 0.55) : x.projected !== undefined && x.projected > 100
  if (forecastOver || x.p >= 85) return 'slow'
  return 'ok'
}

export function forecast(x: ForecastInput): Forecast {
  const L = WINDOW_MS[baseKind(x.kind)]
  const label = labelOf(x.kind)
  const msToReset = x.resetsAt !== undefined ? Math.max(0, x.resetsAt - x.now) : undefined
  const isWeek = isWeekly(x.kind)
  // The 5-hour window is judged on the last hour; the week on the last day,
  // since nobody works 24 hours straight.
  const lookback = isWeek ? DAY : HOUR
  // k as learned, scaled by how far past forecasts ran off at percent level.
  const c = x.correction ?? 1
  const k = x.cal?.k === undefined ? undefined : x.cal.k * c

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
    // Settings the replay of past weeks tuned (or the defaults).
    const t = x.tune ?? defaultTuning(x.kind)
    const base = expectedBase(x.prof, x.between, x.kind, x.now, x.resetsAt, t.tau) * t.bias
    projected = x.p + k * base

    // Spread: how the same stretch varied in the past, one scenario per past
    // stretch, smoothed (kernel density) and widened by the uncertainty of k.
    // The 80% range and the risk both come from that one distribution.
    const past = pastStretches(x.between, x.kind, x.now, x.resetsAt, x.prof.since)
    if (past.length >= 3) {
      const sims = scenarios(base, past, t.scale).map(u => x.p + k * u)
      const kSd = (x.cal?.se ?? 0) * c * base
      lo = Math.max(x.p, kdeQuantile(sims, 0.1, kSd))
      hi = kdeQuantile(sims, 0.9, kSd)
      risk = kdeTail(sims, 100, kSd)
      samples = past.length
    }
  }

  const perDayLeft = isWeek && msToReset !== undefined && msToReset > 0
    ? Math.max(0, 100 - x.p) / Math.max(msToReset / DAY, 1 / 24)
    : undefined

  const soon = runsOutSoon(x.kind, msToLimit, msToReset)
  const verdict = verdictFor({ kind: x.kind, p: x.p, risk, projected, msToLimit, msToReset, prev: x.prev })

  const unit = isWeek ? 'weeks' : 'days'
  const range = lo !== undefined && hi !== undefined ? ` (80%: ${fmtRange(lo, hi)})` : ''
  let headline: string
  if (x.p >= 95) headline = `${label} limit almost used (${fmtPct(x.p)}).`
  else if (soon) headline = `${label}: at this speed you hit the limit in ~${dur(msToLimit!)}, reset is in ${dur(msToReset!)}.`
  else if (risk !== undefined && risk > 0.5) headline = `${label}: ${fmtPct(risk * 100)} risk of running out before the reset in ${dur(msToReset!)} (compared with ${samples} past ${unit}).`
  else if (projected !== undefined && projected > 100 && msToReset !== undefined) headline = `${label}: set to run out before the reset in ${dur(msToReset)}, forecast ~${fmtPct(projected)}${range}.`
  else if (projected !== undefined && msToReset !== undefined) headline = `${label}: on track for ~${fmtPct(projected)}${range} at reset in ${dur(msToReset)}.`
  else if (msToReset !== undefined) headline = `${label}: ${fmtPct(x.p)} used, reset in ${dur(msToReset)}.`
  else headline = `${label}: ${fmtPct(x.p)} used.`

  const f: Forecast = { kind: x.kind, label, p: x.p, rateBasis, verdict, headline }
  Object.assign(f, strip({ msToReset, rate, msToLimit, projected, lo, hi, risk, samples, baseline, pace, perDayLeft }))
  if (samples !== undefined) f.sampleUnit = unit
  if (c !== 1) f.correction = c
  if (x.share) f.share = x.share
  return f
}

const strip = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

/** The forecast to log for scoring later, or undefined when there is none. */
export function toLog(f: Forecast, t: number, r: string | undefined): ForecastLog | undefined {
  if (f.projected === undefined || !r) return undefined
  const round = (v?: number) => (v === undefined ? undefined : Math.round(v * 10) / 10)
  return strip({ t, kind: f.kind, r, p: f.p, pt: round(f.projected)!, lo: round(f.lo), hi: round(f.hi), risk: round(f.risk), n: f.samples, b: round(f.baseline), c: round(f.correction) }) as ForecastLog
}

export type Quality = {
  kind: string
  /** Forecasts scored (windows that have reset). */
  n: number
  /** Distinct windows among them. */
  windows: number
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
  /** Σ actual ÷ Σ forecast increase, the forecasts taken before any correction they carried. */
  ratio?: number
}

/**
 * Scores logged forecasts against what happened: the final percent of each
 * window that has reset. Several sessions may log the same forecast, so one
 * per window and hour counts.
 */
export function evaluate(logs: ForecastLog[], readings: Reading[], kind: string, now: number, since = now - LOOKBACK_DAYS * DAY): Quality {
  const final = new Map<string, number>()
  for (const x of readings) if (x.kind === kind && x.r) final.set(x.r, Math.max(final.get(x.r) ?? 0, x.p))
  const seen = new Set<string>()
  const scored: { f: ForecastLog; y: number }[] = []
  for (const f of [...logs].sort((a, b) => a.t - b.t)) {
    if (f.kind !== kind || f.t < since || !(Date.parse(f.r) <= now)) continue
    // The window's last reading is its outcome, also when it came before the
    // forecast: usage after it would have moved the window and been read.
    const y = final.get(f.r)
    const key = `${f.r}|${Math.floor(f.t / HOUR)}`
    if (y === undefined || seen.has(key)) continue
    seen.add(key)
    scored.push({ f, y: Math.min(y, 100) })
  }
  const q: Quality = { kind, n: scored.length, windows: new Set(scored.map(s => s.f.r)).size, nInterval: 0, nRisk: 0 }
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
  // How far the increases ran off, a ratio estimator again; both sides capped
  // at the room the window had, so a run-out forecast right counts as right.
  let actual = 0
  let predicted = 0
  for (const s of scored) {
    const room = Math.max(0, 100 - s.f.p)
    actual += clamp(s.y - s.f.p, 0, room)
    predicted += clamp((s.f.pt - s.f.p) / (s.f.c ?? 1), 0, room)
  }
  if (predicted > 0) q.ratio = actual / predicted
  return q
}

/**
 * What k is scaled by: the scored ratio once 5 forecasts over 3 windows are
 * in, clipped to 0.5–1.5, and 1 when within 5% of it. Catches a k learned too
 * high from usage elsewhere (claude.ai, another machine) and the weeks the
 * replay cannot tune yet.
 */
export function correction(q: Pick<Quality, 'ratio' | 'n' | 'windows'>): number {
  if (q.ratio === undefined || q.n < 5 || q.windows < 3) return 1
  const c = clamp(q.ratio, 0.5, 1.5)
  return Math.abs(c - 1) < 0.05 ? 1 : c
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

/** What to switch a family to for routine work, and the model that stands for the family in the price table. */
const SWAP: Record<Family, { model: string; to: [string, string][] }> = {
  fable: { model: 'claude-fable-5-1', to: [['Opus 5.5', 'claude-opus-5-5'], ['Sonnet 5.5', 'claude-sonnet-5-5']] },
  opus: { model: 'claude-opus-5-5', to: [['Sonnet 5.5', 'claude-sonnet-5-5']] },
}

export function suggestions(x: SuggestionInput): Tip[] {
  const out: Tip[] = []
  const short = x.forecasts.find(f => f.kind === 'five_hour')
  const week = x.forecasts.find(f => f.kind === 'seven_day')
  // Tight: not OK, or OK but the forecast or risk says it is close.
  const tight = (f?: Forecast) => !!f && (f.verdict !== 'ok' || (f.projected ?? 0) >= 100 || (f.risk ?? 0) >= 0.5)
  const anyPressure = x.forecasts.some(f => tight(f))
  const [total, sub, opus, fable] = x.between(x.now - 5 * HOUR, x.now)

  if (anyPressure) {
    if ((x.context ?? 0) > 120_000) {
      out.push({ id: 'context', text: `Your context is ~${Math.round((x.context ?? 0) / 1000)}k tokens and every message re-sends it: /compact, or /clear when you switch topics.` })
    }
    const heavy: Family | undefined = total > 0 && fable / total > 0.6 ? 'fable' : total > 0 && opus / total > 0.6 ? 'opus' : undefined
    // A model's own window is tight: only that model fills it, so switching is the whole remedy.
    const own = x.forecasts.find(f => scopeOf(f.kind) !== undefined && tight(f))
    if (own) {
      out.push({ id: 'model', text: `${own.label} has a weekly limit of its own and it is at ${fmtPct(own.p)}: other models don't count against it, so keep ${own.label} for the work that needs it (/model).` })
    } else if (heavy) {
      const s = SWAP[heavy]
      const times = (id: string) => `${Math.round((price(s.model).input / price(id).input) * 10) / 10}×`
      const [first, second] = s.to
      out.push({
        id: 'model',
        text: `Most recent usage is ${FAMILY_LABEL[heavy]}. ${first![0]} for routine work (/model) makes the same limit last about ${times(first![1])} longer${second ? `, ${second[0]} about ${times(second[1])}` : ''}.`,
      })
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
 * One window's fields of the limits line, apart so they can be drawn in their
 * own colors. `tone` colors the forecast: bad over 100%, warn when it is near
 * or its range reaches past the limit.
 */
export function statusParts(f: Forecast) {
  const tone: 'good' | 'warn' | 'bad' | undefined = f.projected === undefined
    ? undefined
    : f.projected > 100 ? 'bad' : f.projected >= 90 || (f.hi ?? 0) > 100 ? 'warn' : 'good'
  return {
    name: shortOf(f.kind),
    pct: fmtPct(f.p),
    reset: f.msToReset === undefined ? '–' : dur(f.msToReset),
    ahead: f.projected === undefined ? '–' : fmtPct(f.projected),
    risk: f.risk === undefined ? '–' : fmtPct(f.risk * 100),
    verdict: VERDICT_TEXT[f.verdict],
    tone,
  }
}

/** Cells of the small bar in the limits line. It draws one more character, the limit mark. */
export const LINE_BAR = 10

/** What the limits line shows: `fitLine` picks the fullest set that fits the terminal. */
export type LineOpts = { compact: boolean; bars: boolean; risk: boolean; time: boolean; ctx: boolean; sep: string }

export type LinePart = { kind: 'dim' | 'bar' | 'pct' | 'reset' | 'ahead' | 'risk' | 'dot' | 'verdict'; text: string; tone?: 'good' | 'warn' | 'bad' }

/**
 * One window's pieces of the line, in order. The same fields whatever the
 * verdict, a dash for what is not known yet; compact shows the forecast and
 * the risk under pressure only.
 *   5h 42% ↻ 2h30 → 68% risk 0% ● OK
 */
export function lineParts(f: Forecast, o: Pick<LineOpts, 'compact' | 'bars' | 'risk'>): LinePart[] {
  const s = statusParts(f)
  const parts: LinePart[] = [{ kind: 'dim', text: `${s.name} ` }]
  if (o.bars) parts.push({ kind: 'bar', text: '' }, { kind: 'dim', text: ' ' })
  parts.push({ kind: 'pct', text: s.pct }, { kind: 'dim', text: o.compact ? ' ↻' : ' ↻ ' }, { kind: 'reset', text: s.reset })
  if (!o.compact || f.verdict !== 'ok') {
    parts.push({ kind: 'dim', text: o.compact ? ' →' : ' → ' }, { kind: 'ahead', text: s.ahead, tone: s.tone })
    if (o.risk) parts.push({ kind: 'dim', text: ' risk ' }, { kind: 'risk', text: s.risk })
  }
  parts.push({ kind: 'dot', text: o.compact ? ' ●' : ' ● ' }, { kind: 'verdict', text: s.verdict })
  return parts
}

/** The line as plain text, bars stood in for by their width: what the terminal has to fit. */
export function lineText(forecasts: Forecast[], o: LineOpts, at?: number, ctx?: string): string {
  const windows = forecasts.map(f => lineParts(f, o).map(p => (p.kind === 'bar' ? '#'.repeat(LINE_BAR + 1) : p.text)).join('')).join(o.sep)
  return windows + (o.time && at !== undefined ? `   · ${hhmm(at)}` : '') + (o.ctx && ctx ? `   · ${ctx}` : '')
}

/**
 * The fullest line that fits `columns`: the bars go first, then the context,
 * the spacing, the time and the risk. Compact never has bars, time or context.
 */
export function fitLine(forecasts: Forecast[], columns: number | undefined, compact: boolean, at?: number, ctx?: string): LineOpts {
  const o: LineOpts = compact
    ? { compact, bars: false, risk: true, time: false, ctx: false, sep: ' │ ' }
    : { compact, bars: true, risk: true, time: at !== undefined, ctx: !!ctx, sep: '   │   ' }
  for (const step of ['bars', 'ctx', 'sep', 'time', 'risk'] as const) {
    if (columns === undefined || lineText(forecasts, o, at, ctx).length <= columns) break
    if (step === 'sep') o.sep = ' │ '
    else o[step] = false
  }
  return o
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
