import { expect, test } from 'claude-code/testing'

import {
  addToBuckets, calibrate, correction, DAY, evaluate, familyWeight, fitLine, forecast, hitReadings, HOUR, lineText, mergeHits, parseTranscript, price, profile, rangeBar,
  reweight, statusParts, suggestions, dur, units, usageIndex, verdictFor, weightCheck, ASSUMED_REL_SE, defaultTuning, MIN_REPLAY, tune,
  familyBuckets, scopedLimits, startReadings,
} from '../hooks/model'
import type { Buckets, Forecast, ForecastLog, Tuning, Reading, Turn } from '../hooks/model'
import { kdeQuantile, kdeTail, normCdf, quantile, ratioFit } from '../hooks/stats'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const close = (x: number | undefined, v: number) => expect(Math.abs((x ?? NaN) - v)).toBeLessThan(1e-6)
const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'
const FABLE = 'claude-fable-5-1'

/** A turn worth `u` units. */
const turnU = (t: number, u: number, model = SONNET, sub = false): Turn =>
  ({ t, model, in: 0, cw: 0, cr: 0, out: (u * 1e6) / (5 * price(model).input), sub })

test('parses a transcript once per message, collecting tool calls across its lines', async () => {
  const msg = (id: string, ts: string, out: number, content: unknown[] = [], side = false) =>
    JSON.stringify({
      type: 'assistant', timestamp: ts, isSidechain: side,
      message: { id, model: OPUS, content, usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: out } },
    })
  const text = [
    msg('a', '2026-10-07T10:00:00Z', 50, [{ type: 'text', text: 'hi' }]),
    msg('a', '2026-10-07T10:00:01Z', 50, [{ type: 'tool_use', name: 'Bash' }]),
    msg('b', '2026-10-07T10:05:00Z', 20, [{ type: 'tool_use', name: 'Read' }], true),
    '{"type":"user"}', 'not json',
  ].join('\n')
  const { turns } = parseTranscript(text)
  expect(turns.length).toBe(2)
  expect(turns[0]?.tools).toEqual(['Bash'])
  expect(turns[1]?.sub).toBe(true)
})

test('parses limit hits, compactions, turn durations, effort, attribution and the cache write split', async () => {
  const resetsAt = Date.parse('2026-09-30T12:00:00Z') / 1000
  const hit = (ts: string) => JSON.stringify({
    type: 'assistant', timestamp: ts, error: 'rate_limit', isApiErrorMessage: true,
    quotaLimits: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' },
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'You have hit your session limit' }], usage: { input_tokens: 0, output_tokens: 0 } },
  })
  const text = [
    hit('2026-09-30T10:59:00Z'),
    hit('2026-09-30T10:59:05Z'),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-09-30T09:00:00Z', compactMetadata: { trigger: 'manual', preTokens: 389929, postTokens: 11405 } }),
    JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: '2026-09-30T09:10:00Z', durationMs: 23230, isSidechain: false }),
    JSON.stringify({
      type: 'assistant', timestamp: '2026-09-30T09:09:00Z', effort: 'high', perTurnEffort: 'medium', attributionSkill: 'code-review', attributionAgent: 'Explore',
      thinkingDurationMs: 700, isAbortedMidStream: true,
      message: {
        id: 'x', model: OPUS, content: [],
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 3, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 } },
      },
    }),
  ].join('\n')
  const tr = parseTranscript(text)
  expect(tr.hits).toEqual([{ t: Date.parse('2026-09-30T10:59:00Z'), kind: 'five_hour', r: '2026-09-30T12:00:00.000Z', tries: 2 }])
  expect(tr.compactions).toEqual([{ t: Date.parse('2026-09-30T09:00:00Z'), trigger: 'manual', pre: 389929, post: 11405 }])
  expect(tr.durations).toEqual([{ t: Date.parse('2026-09-30T09:10:00Z'), ms: 23230 }])
  expect(tr.turns.length).toBe(1)
  expect(tr.turns[0]).toMatchObject({ effort: 'medium', attr: ['skill:code-review', 'agent:Explore'], thinkMs: 700, aborted: true, cw: 3, cw1h: 2 })
})

test('past limit hits alone teach tokens → %: 0% at the window start, 100% when refused', async () => {
  const b: Buckets = {}
  const hits = [3, 2, 1].map(d => {
    const r = NOW - d * DAY
    const start = r - 5 * HOUR
    // About 73 units fill the window; the hit comes after 3 hours.
    for (let h = 0; h < 3; h++) addToBuckets(b, turnU(start + h * HOUR + 10 * 60_000, [24, 25, 24.3][h]!))
    return { t: start + 3 * HOUR, kind: 'five_hour', r: new Date(r).toISOString(), tries: 1 }
  })
  const readings = hitReadings(mergeHits([...hits, { ...hits[0]!, t: hits[0]!.t + 60_000 }]))
  expect(readings.length).toBe(6)
  const c = calibrate(readings, usageIndex(b), 'five_hour', NOW)
  expect(c.n).toBe(3)
  close(c.k, 100 / 73.3)
  // One hit alone: learned, with an assumed ±25% until there are 3.
  const one = calibrate(readings.slice(0, 2), usageIndex(b), 'five_hour', NOW)
  expect(one.seAssumed).toBe(true)
  close(one.se! / one.k!, ASSUMED_REL_SE)
})

test('a change in the limits is noticed from the two latest stretches', async () => {
  const { b, readings } = history(0.5, () => 5)
  // Today the same usage moves the window twice as far.
  const start = NOW - 6 * HOUR
  const r = new Date(start + 5 * HOUR).toISOString()
  readings.push({ t: start, kind: 'five_hour', p: 0, r })
  for (let h = 0; h < 2; h++) {
    addToBuckets(b, turnU(start + h * HOUR + 30 * 60_000, 5))
    readings.push({ t: start + (h + 1) * HOUR, kind: 'five_hour', p: (h + 1) * 5, r })
  }
  const c = calibrate(readings, usageIndex(b), 'five_hour', NOW)
  close(c.k, 1)
  expect(c.changedAt).toBe(start)
  // One odd stretch is noise, not a change.
  const noise = calibrate(readings.slice(0, -1), usageIndex(b), 'five_hour', NOW)
  expect(noise.changedAt).toBe(undefined)
  expect(noise.k!).toBeLessThan(0.6)
})

test('weights tokens like API list prices, per family and generation', async () => {
  const out = { in: 0, cw: 0, cr: 0, out: 1_000_000 }
  expect(units({ model: OPUS, ...out })).toBe(20)
  expect(units({ model: SONNET, ...out })).toBe(10)
  expect(units({ model: FABLE, ...out })).toBe(50)
  // Cache reads: a share of the input price that differs per model.
  const reads = { in: 0, cw: 0, cr: 1_000_000, out: 0 }
  close(units({ model: FABLE, ...reads }), 0.25)
  close(units({ model: OPUS, ...reads }), 0.2)
  close(units({ model: SONNET, ...reads }), 0.2)
  // Cache writes: 1.25× the input for the 5-minute cache, 2× for the hour-long one.
  close(units({ model: SONNET, in: 0, cw: 1_000_000, cr: 0, out: 0 }), 2.5)
  close(units({ model: SONNET, in: 0, cw: 1_000_000, cw1h: 1_000_000, cr: 0, out: 0 }), 4)
  expect(price('claude-haiku-5-5').input).toBe(0.1)
  expect(price('claude-opus-5').input).toBe(5)
  expect(price('something-new').input).toBe(2)
})

test('usage index sums ranges and prorates the edge buckets, each family apart', async () => {
  const b: Buckets = {}
  addToBuckets(b, turnU(NOW, 4))
  addToBuckets(b, turnU(NOW + HOUR, 8, OPUS, true))
  addToBuckets(b, turnU(NOW + 2 * HOUR, 2, FABLE))
  const between = usageIndex(b)
  expect(between(NOW - HOUR, NOW + 3 * HOUR)).toEqual([14, 8, 8, 2])
  // Half of the first 15-minute bucket.
  close(between(NOW, NOW + 7.5 * 60_000)[0], 2)
  close(between(NOW + 7.5 * 60_000, NOW + HOUR + 60_000)[0], 2 + 8 / 15)
})

test('stats: quantile interpolates, ratio fit gives k and a standard error', async () => {
  expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
  // Smoothed tail: symmetric samples split evenly, far ones still count a little.
  expect(Math.abs(normCdf(1.2816) - 0.9)).toBeLessThan(1e-4)
  close(kdeTail([90, 110], 100), 0.5)
  const tail = kdeTail([60, 70, 80, 90], 100)
  expect(tail).toBeGreaterThan(0.01)
  expect(tail).toBeLessThan(0.25)
  // No spread at all: the plain share.
  expect(kdeTail([80, 80, 80], 100)).toBe(0)
  // The range and the risk come from one distribution: 10% lie above its 90% point.
  const xs = [70, 85, 92, 120]
  expect(Math.abs(kdeTail(xs, kdeQuantile(xs, 0.9, 5), 5) - 0.1)).toBeLessThan(1e-6)
  expect(kdeQuantile([80, 80, 80], 0.9)).toBe(80)
  const fit = ratioFit([{ y: 2, x: 4, w: 1 }, { y: 3, x: 6, w: 1 }, { y: 5.5, x: 10, w: 1 }])
  close(fit?.k, 10.5 / 20)
  expect(fit?.se).toBeGreaterThan(0)
})

/** One 5-hour window per day: usage per hour, and readings as the window moves with k. */
function history(k: number, perHour: (day: number, hour: number) => number, days = 5) {
  const b: Buckets = {}
  const readings: Reading[] = []
  for (let d = days; d >= 1; d--) {
    const start = NOW - d * DAY
    const r = new Date(start + 5 * HOUR).toISOString()
    let p = 0
    readings.push({ t: start, kind: 'five_hour', p, r })
    for (let h = 0; h < 4; h++) {
      const u = perHour(d, h)
      addToBuckets(b, turnU(start + h * HOUR + 30 * 60_000, u))
      p += k * u
      readings.push({ t: start + (h + 1) * HOUR, kind: 'five_hour', p, r })
    }
  }
  return { b, readings }
}

test('calibration learns percent per unit from all usage between readings', async () => {
  const { b, readings } = history(0.5, (d, h) => 4 + ((d + h) % 3))
  const c = calibrate(readings, usageIndex(b), 'five_hour', NOW)
  close(c.k, 0.5)
  expect(c.n).toBe(20)
  close(c.se, 0)
  // Points moved without any Claude Code usage were spent elsewhere: left out.
  const elsewhere = [...readings, { t: NOW - 2 * HOUR, kind: 'five_hour', p: 0, r: 'X' }, { t: NOW - HOUR, kind: 'five_hour', p: 30, r: 'X' }]
  close(calibrate(elsewhere, usageIndex(b), 'five_hour', NOW).k, 0.5)
  // Too few points (2 stretches of 0.8): not learned yet.
  const few = history(0.2, () => 4, 1)
  const c2 = calibrate(few.readings.slice(0, 3), usageIndex(few.b), 'five_hour', NOW)
  close(c2.points, 1.6)
  expect(c2.k).toBe(undefined)
})

test('a clear family weight is applied, an unclear one is not', async () => {
  expect(familyWeight({ ratio: 1.3, se: 0.05 })).toBe(1.3)
  // Within 2 standard errors of 1, or too imprecise: keep the assumed weight.
  expect(familyWeight({ ratio: 1.08, se: 0.05 })).toBe(1)
  expect(familyWeight({ ratio: 1.6, se: 0.5 })).toBe(1)
  expect(familyWeight(undefined)).toBe(1)
  expect(reweight({ '0': [10, 0, 4, 2] }, { opus: 1.5, fable: 2 })).toEqual({ '0': [14, 0, 6, 4] })
  expect(reweight({ '0': [10, 0, 4, 2] }, { opus: 1, fable: 1 })).toEqual({ '0': [10, 0, 4, 2] })
})

test('the weight check finds a family costing more than assumed', async () => {
  for (const [model, fam] of [[OPUS, 'opus'], [FABLE, 'fable']] as const) {
    const b: Buckets = {}
    const readings: Reading[] = []
    const r = new Date(NOW + HOUR).toISOString()
    let p = 0
    const t0 = NOW - 9 * HOUR
    readings.push({ t: t0, kind: 'five_hour', p, r })
    for (let i = 0; i < 8; i++) {
      const heavy = [1, 4, 2, 6, 0.5, 3, 5, 1.5][i]!
      const other = [5, 1, 3, 2, 6, 4, 0.5, 2][i]!
      addToBuckets(b, turnU(t0 + i * HOUR + 30 * 60_000, heavy, model))
      addToBuckets(b, turnU(t0 + i * HOUR + 31 * 60_000, other))
      p += 0.5 * (1.5 * heavy + other)
      readings.push({ t: t0 + (i + 1) * HOUR, kind: 'five_hour', p, r })
    }
    const check = weightCheck(readings, usageIndex(b), NOW, fam)
    close(check?.ratio, 1.5)
  }
})

test('5-hour window: the current speed runs out soon → hold on; later → slow down', async () => {
  const b: Buckets = {}
  addToBuckets(b, turnU(NOW - 30 * 60_000, 10))
  const between = usageIndex(b)
  // 10 units in the last hour; with k = 2 that is 20%/h.
  const f = forecast({ kind: 'five_hour', p: 50, resetsAt: NOW + 3 * HOUR, now: NOW, cal: { k: 2 }, between, readings: [] })
  expect(Math.round(f.rate ?? 0)).toBe(20)
  expect(Math.round((f.msToLimit ?? 0) / 60_000)).toBe(150)
  expect(f.verdict).toBe('slow')
  const g = forecast({ kind: 'five_hour', p: 90, resetsAt: NOW + 3 * HOUR, now: NOW, cal: { k: 2 }, between, readings: [] })
  expect(g.verdict).toBe('hold')
  // The scored correction scales k, and the forecast says so.
  const h = forecast({ kind: 'five_hour', p: 50, resetsAt: NOW + 3 * HOUR, now: NOW, cal: { k: 2 }, between, readings: [], correction: 0.5 })
  expect(Math.round(h.rate ?? 0)).toBe(10)
  expect(h.correction).toBe(0.5)
  expect(f.correction).toBe(undefined)
})

test('the verdict holds between 45% and 55% risk, and the week needs the limit within 6 hours to say hold on', async () => {
  const base = { kind: 'seven_day', p: 60, projected: 95, msToReset: 2 * DAY }
  expect(verdictFor({ ...base, risk: 0.5 })).toBe('ok')
  expect(verdictFor({ ...base, risk: 0.5, prev: 'slow' })).toBe('slow')
  expect(verdictFor({ ...base, risk: 0.56 })).toBe('slow')
  expect(verdictFor({ ...base, risk: 0.44, prev: 'slow' })).toBe('ok')
  // Hard data only: at the current speed, the limit within 6 hours (45 minutes for the 5-hour window).
  expect(verdictFor({ ...base, risk: 0.1, msToLimit: 5 * HOUR })).toBe('hold')
  expect(verdictFor({ ...base, risk: 0.1, msToLimit: 10 * HOUR })).toBe('ok')
  expect(verdictFor({ kind: 'five_hour', p: 60, msToLimit: 40 * 60_000, msToReset: 2 * HOUR })).toBe('hold')
  expect(verdictFor({ kind: 'five_hour', p: 60, msToLimit: 50 * 60_000, msToReset: 2 * HOUR })).toBe('ok')
  expect(verdictFor({ kind: 'five_hour', p: 86, msToReset: 2 * HOUR })).toBe('slow')
})

test('no usage lately → OK, and weekly gives a per-day budget', async () => {
  const f = forecast({ kind: 'seven_day', p: 40, resetsAt: NOW + 3.5 * DAY, now: NOW, cal: { k: 2 }, between: usageIndex({}), readings: [] })
  expect(f.verdict).toBe('ok')
  expect(Math.round(f.pace ?? 0)).toBe(50)
  expect(Math.round(f.perDayLeft ?? 0)).toBe(17)
})

test("a model's own weekly window is read from the usage answer and counts that model's usage alone", async () => {
  // The answer's shape as the endpoint gives it to Claude Code 2.1.327.
  const body = {
    five_hour: { utilization: 73, resets_at: '2026-10-07T15:00:00.123456+00:00' },
    limits: [
      { kind: 'session', percent: 73, resets_at: '2026-10-07T15:00:00.123456+00:00', scope: null },
      { kind: 'weekly_all', percent: 29, resets_at: '2026-10-09T12:59:59.856658+00:00', scope: null },
      { kind: 'weekly_scoped', percent: 49, resets_at: '2026-10-09T12:59:59.856990+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
      { kind: 'weekly_scoped', percent: 'x', scope: { model: { display_name: 'Broken' } } },
    ],
    weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 25, allowance_percent_of_weekly: 50 }],
  }
  // The reset to the minute: its microseconds must not split one window's readings.
  expect(scopedLimits(body)).toEqual([{ kind: 'seven_day_fable', percentUsed: 49, resetsAt: '2026-10-09T13:00:00.000Z', share: { used: 25, allowance: 50 } }])
  expect(scopedLimits({ limits: [{ kind: 'weekly_scoped', percent: 5, resets_at: Date.parse('2026-10-09T13:00:00Z') / 1000, scope: { model: { display_name: 'Opus 5.5' } } }] }))
    .toEqual([{ kind: 'seven_day_opus_5_5', percentUsed: 5, resetsAt: '2026-10-09T13:00:00.000Z' }])
  for (const junk of [null, 'x', {}, { limits: 'x' }, { limits: [null, { kind: 'weekly_scoped' }] }]) expect(scopedLimits(junk)).toEqual([])

  // 10 units of Opus and 4 of Fable in the last day: Fable's window sees the 4.
  const b: Buckets = {}
  addToBuckets(b, turnU(NOW - 2 * HOUR, 10, OPUS))
  addToBuckets(b, turnU(NOW - 2 * HOUR, 4, FABLE))
  const between = usageIndex(familyBuckets(b, 'fable'))
  close(between(NOW - DAY, NOW)[0], 4)
  expect(familyBuckets(b, 'other')).toEqual({})
  const f = forecast({ kind: 'seven_day_fable', p: 49, resetsAt: NOW + 3.5 * DAY, now: NOW, cal: { k: 1.5 }, between, readings: [], share: { used: 25, allowance: 50 } })
  // A weekly window in everything but its name: a day's look-back, an even pace, a budget per day.
  expect(f.label).toBe('Fable')
  expect(statusParts(f).name).toBe('fable')
  close(f.rate, 0.25)
  expect(Math.round(f.pace ?? 0)).toBe(50)
  expect(Math.round(f.perDayLeft ?? 0)).toBe(15)
  expect(f.share).toEqual({ used: 25, allowance: 50 })
  expect(f.verdict).toBe('ok')
  // The first read, mid-week, already teaches tokens → %: the window began at 0% a week before its reset.
  const r = new Date(NOW + 3.5 * DAY).toISOString()
  const first: Reading[] = [{ t: NOW, kind: 'seven_day_fable', p: 40, r }, { t: NOW, kind: 'seven_day', p: 30, r }]
  expect(startReadings(first)).toEqual([{ t: NOW - 3.5 * DAY, kind: 'seven_day_fable', p: 0, r }])
  const c = calibrate([...first, ...startReadings(first)], between, 'seven_day_fable', NOW)
  close(c.k, 10)
  expect(c).toMatchObject({ n: 1, points: 40, seAssumed: true })
  expect(calibrate(first, between, 'seven_day_fable', NOW).k).toBe(undefined)
  // Tight, it says which limit it is: only switching models spares it.
  const tight = forecast({ kind: 'seven_day_fable', p: 90, resetsAt: NOW + 3.5 * DAY, now: NOW, cal: { k: 1.5 }, between, readings: [] })
  const tips = suggestions({ forecasts: [tight], between: usageIndex(b), now: NOW })
  expect(tips.map(t => t.id)).toEqual(['model'])
  expect(tips[0]?.text).toContain('Fable has a weekly limit of its own and it is at 90%')
})

test('not calibrated yet: the speed is the least-squares slope of the readings', async () => {
  const readings = [
    { t: NOW - 50 * 60_000, kind: 'five_hour', p: 40, r: 'R' },
    { t: NOW - 30 * 60_000, kind: 'five_hour', p: 47, r: 'R' },
    { t: NOW - 5 * 60_000, kind: 'five_hour', p: 55, r: 'R' },
  ]
  const f = forecast({ kind: 'five_hour', p: 55, resetsAt: NOW + 4 * HOUR, now: NOW, between: usageIndex({}), readings, r: 'R' })
  expect(Math.round(f.rate ?? 0)).toBe(20)
  expect(f.verdict).toBe('slow')
  // Two readings are not enough for a slope.
  expect(forecast({ kind: 'five_hour', p: 55, resetsAt: NOW + 4 * HOUR, now: NOW, between: usageIndex({}), readings: readings.slice(1), r: 'R' }).rate).toBe(undefined)
})

/** Five weeks of workday usage, 9 to 17 local time; `perDay` by weeks ago. */
function workdays(perDay: (weeksAgo: number) => number): Buckets {
  const b: Buckets = {}
  for (let d = 1; d <= 35; d++) {
    const day = new Date(NOW - d * DAY)
    day.setHours(0, 0, 0, 0)
    if (day.getDay() === 0 || day.getDay() === 6) continue
    for (let h = 9; h < 17; h++) addToBuckets(b, turnU(day.getTime() + h * HOUR + 10 * 60_000, perDay(Math.floor(d / 7)) / 8))
  }
  return b
}

test('a regular user gets a narrow 80% range, an irregular one a wide range', async () => {
  const run = (b: Buckets) => {
    const between = usageIndex(b)
    return forecast({ kind: 'seven_day', p: 50, resetsAt: NOW + 3.5 * DAY, now: NOW, cal: { k: 1 }, between, readings: [], prof: profile(b, NOW) })
  }
  const regular = run(workdays(() => 8))
  const irregular = run(workdays(w => (w % 2 ? 2 : 14)))
  expect(regular.samples).toBeGreaterThanOrEqual(3)
  expect(regular.sampleUnit).toBe('weeks')
  const width = (f: typeof regular) => (f.hi ?? 0) - (f.lo ?? 0)
  expect(width(regular)).toBeLessThan(1)
  expect(width(irregular)).toBeGreaterThan(10)
  // Uncertainty about k widens the range too.
  const unsure = forecast({ kind: 'seven_day', p: 50, resetsAt: NOW + 3.5 * DAY, now: NOW, cal: { k: 1, se: 0.2 }, between: usageIndex(workdays(() => 8)), readings: [], prof: profile(workdays(() => 8), NOW) })
  expect(width(unsure)).toBeGreaterThan(width(regular) + 5)
})

test('the risk is the share of past weeks that would run out', async () => {
  const b = workdays(w => (w % 2 ? 4 : 30))
  const f = forecast({ kind: 'seven_day', p: 60, resetsAt: NOW + 3.5 * DAY, now: NOW, cal: { k: 1 }, between: usageIndex(b), readings: [], prof: profile(b, NOW) })
  expect(f.risk).toBeGreaterThan(0)
  expect(f.risk).toBeLessThan(1)
  // Smoothed: not a multiple of 1/samples.
  expect((f.risk! * f.samples!) % 1).not.toBe(0)
  // "Slow down" starts above 55% risk.
  expect(f.verdict).toBe(f.risk! > 0.55 ? 'slow' : 'ok')
  // Uncertainty about k spreads the outcome too, so the risk moves toward 50%.
  const unsure = forecast({ kind: 'seven_day', p: 60, resetsAt: NOW + 3.5 * DAY, now: NOW, cal: { k: 1, se: 0.3 }, between: usageIndex(b), readings: [], prof: profile(b, NOW) })
  expect(Math.abs(unsure.risk! - 0.5)).toBeLessThan(Math.abs(f.risk! - 0.5))
  // A pattern forecast alone never says "hold on".
  expect(f.verdict === 'hold').toBe(false)
})

test('replaying the past tunes the forecast, once there is enough of it', async () => {
  const b = workdays(w => (w % 2 ? 4 : 30))
  // Weekly: 5 weeks of history give too few non-overlapping replays.
  const wk = tune(b, 'seven_day', NOW, 2 * DAY)
  expect(wk.independent).toBeLessThan(MIN_REPLAY)
  expect(wk).toMatchObject({ scale: 1, bias: 1, tau: defaultTuning('seven_day').tau })
  // 5-hour: plenty of past days, and the tuned range holds closer to 80%.
  const t = tune(b, 'five_hour', NOW, 3 * HOUR)
  expect(t.independent).toBeGreaterThanOrEqual(MIN_REPLAY)
  expect(Math.abs(t.coverage! - 0.8)).toBeLessThanOrEqual(Math.abs(t.coverage0! - 0.8))
  // Tuned settings reach the forecast: a wider range, a bias.
  const f = (tn?: Tuning) => forecast({ kind: 'seven_day', p: 50, resetsAt: NOW + 3.5 * DAY, now: NOW, cal: { k: 1 }, between: usageIndex(b), readings: [], prof: profile(b, NOW), tune: tn })
  const width = (x: Forecast) => x.hi! - x.lo!
  expect(width(f({ ...defaultTuning('seven_day'), scale: 2 }))).toBeGreaterThan(width(f()))
  expect(f({ ...defaultTuning('seven_day'), bias: 0.5 }).projected!).toBeLessThan(f().projected!)
})

test('forecasts are scored once their window has reset, and the scored bias becomes a correction', async () => {
  const r1 = '2026-10-01T00:00:00Z'
  const r2 = '2026-10-02T00:00:00Z'
  const r3 = '2026-10-03T00:00:00Z'
  const logs: ForecastLog[] = [
    { t: Date.parse(r1) - 3 * HOUR, kind: 'five_hour', r: r1, p: 50, pt: 80, lo: 70, hi: 90, risk: 0.1, b: 95 },
    { t: Date.parse(r1) - 3 * HOUR + 60_000, kind: 'five_hour', r: r1, p: 50, pt: 1, b: 1 },
    { t: Date.parse(r2) - 3 * HOUR, kind: 'five_hour', r: r2, p: 50, pt: 90, lo: 80, hi: 99, risk: 0.6, b: 100 },
    { t: NOW - HOUR, kind: 'five_hour', r: new Date(NOW + HOUR).toISOString(), p: 50, pt: 70 },
  ]
  const readings: Reading[] = [
    { t: Date.parse(r1) - HOUR, kind: 'five_hour', p: 85, r: r1 },
    { t: Date.parse(r2) - HOUR, kind: 'five_hour', p: 100, r: r2 },
  ]
  const q = evaluate(logs, readings, 'five_hour', NOW)
  // The duplicate of the same hour and the window still running are not scored.
  expect(q.n).toBe(2)
  expect(q.windows).toBe(2)
  close(q.mae, 7.5)
  close(q.bias, -7.5)
  expect(q.coverage).toBe(0.5)
  close(q.brier, 0.085)
  close(q.skill, -0.5)
  // Increases: 35 and 50 happened against 30 and 40 forecast, each capped at the room the window had.
  close(q.ratio, 85 / 70)
  // A forecast made after a window's last reading is scored too: it went idle, the outcome is that reading.
  const idle = evaluate(
    [...logs, { t: Date.parse(r3) - HOUR, kind: 'five_hour', r: r3, p: 40, pt: 70 }],
    [...readings, { t: Date.parse(r3) - 2 * HOUR, kind: 'five_hour', p: 40, r: r3 }],
    'five_hour', NOW,
  )
  expect(idle.n).toBe(3)
  expect(idle.windows).toBe(3)
  close(idle.ratio, 85 / 100)
  // The correction needs 5 forecasts over 3 windows, is clipped to 0.5–1.5, and ignores a ratio within 5% of 1.
  expect(correction(q)).toBe(1)
  expect(correction({ ratio: 0.3, n: 5, windows: 3 })).toBe(0.5)
  expect(correction({ ratio: 0.8, n: 5, windows: 2 })).toBe(1)
  expect(correction({ ratio: 1.03, n: 9, windows: 4 })).toBe(1)
  close(correction({ ratio: 1.2, n: 9, windows: 4 }), 1.2)
  // A forecast that already carried a correction is undone before it is compared.
  const carried = evaluate([{ t: Date.parse(r1) - 3 * HOUR, kind: 'five_hour', r: r1, p: 50, pt: 65, c: 0.5 }], readings, 'five_hour', NOW)
  close(carried.ratio, 35 / 30)
})

test('suggestions point at the cause', async () => {
  const b: Buckets = {}
  addToBuckets(b, turnU(NOW - HOUR, 25, OPUS, true))
  const between = usageIndex(b)
  const f = forecast({ kind: 'five_hour', p: 96, resetsAt: NOW + HOUR, now: NOW, between, readings: [] })
  const ids = suggestions({ forecasts: [f], between, now: NOW, context: 150_000 }).map(t => t.id)
  expect(ids).toEqual(['context', 'model', 'subagents', 'break'])
  // The model tip names the family in use and what it costs at list prices.
  const fable: Buckets = {}
  addToBuckets(fable, turnU(NOW - HOUR, 25, FABLE))
  const tip = suggestions({ forecasts: [f], between: usageIndex(fable), now: NOW }).find(t => t.id === 'model')
  expect(tip?.text).toBe('Most recent usage is Fable. Opus 5.5 for routine work (/model) makes the same limit last about 2.5× longer, Sonnet 5.5 about 5×.')
})

test('an OK week that is tight still gets tips, never "room for bigger tasks"', async () => {
  const between = usageIndex({})
  const week = (extra: Partial<Forecast>): Forecast =>
    ({ kind: 'seven_day', label: 'Weekly', p: 57, rateBasis: '', headline: '', verdict: 'ok', msToReset: 2 * DAY, pace: 71, perDayLeft: 21.5, ...extra })
  const ids = (f: Forecast) => suggestions({ forecasts: [f], between, now: NOW }).map(t => t.id)
  expect(ids(week({ projected: 102, risk: 0.5 }))).toEqual(['budget'])
  expect(ids(week({ projected: 92, risk: 0.25 }))).toEqual([])
  expect(ids(week({ projected: 80, risk: 0 }))).toEqual(['room'])
})

test('the limits line shows the same fields whatever the verdict, and sheds what does not fit', async () => {
  const f = (kind: string, p: number, extra: object): Forecast => ({ kind, label: kind, p, rateBasis: '', headline: '', verdict: 'ok', ...extra })
  const fs = [
    f('five_hour', 42, { msToReset: 2.5 * HOUR, projected: 68, lo: 61, hi: 77, risk: 0 }),
    f('seven_day', 61, { msToReset: 3 * DAY, projected: 104, lo: 88, hi: 119, risk: 0.75, verdict: 'slow' }),
  ]
  const at = new Date(2026, 9, 7, 14, 2).getTime()
  const ctx = 'ctx 84k/200k 42%'
  const full = fitLine(fs, 300, false, at, ctx)
  expect(full).toMatchObject({ bars: true, ctx: true, time: true, risk: true, sep: '   │   ' })
  const bare = lineText(fs, { ...full, bars: false }, at, ctx)
  expect(bare).toBe('5h 42% ↻ 2h30 → 68% risk 0% ● OK   │   wk 61% ↻ 3d → 104% risk 75% ● SLOW DOWN   · 14:02   · ctx 84k/200k 42%')
  // Narrower: the bars go first, then the context, the spacing, the time, the risk.
  expect(fitLine(fs, bare.length, false, at, ctx)).toMatchObject({ bars: false, ctx: true })
  expect(fitLine(fs, bare.length - 1, false, at, ctx)).toMatchObject({ bars: false, ctx: false, time: true, sep: '   │   ' })
  expect(fitLine(fs, 85, false, at, ctx)).toMatchObject({ ctx: false, sep: ' │ ', time: true })
  expect(fitLine(fs, 80, false, at, ctx)).toMatchObject({ sep: ' │ ', time: false, risk: true })
  expect(fitLine(fs, 70, false, at, ctx)).toMatchObject({ risk: false })
  expect(fitLine(fs, undefined, false, at, ctx).bars).toBe(true)
  // Compact: no bars, time or context; the forecast and the risk only under pressure.
  expect(lineText(fs, fitLine(fs, 300, true, at, ctx), at, ctx)).toBe('5h 42% ↻2h30 ●OK │ wk 61% ↻3d →104% risk 75% ●SLOW DOWN')
  // A dash for what is not known yet.
  expect(lineText([f('five_hour', 30, { msToReset: 3 * HOUR })], { ...full, bars: false, time: false, ctx: false })).toBe('5h 30% ↻ 3h00 → – risk – ● OK')
  expect(dur(47.75 * HOUR)).toBe('1d 23h')
  expect(dur(4 * HOUR + 5 * 60_000)).toBe('4h05')
  // The forecast's color: near or past the limit stands out even while OK.
  expect(statusParts(f('seven_day', 57, { projected: 101, lo: 79, hi: 127 })).tone).toBe('bad')
  expect(statusParts(f('seven_day', 57, { projected: 85, lo: 70, hi: 104 })).tone).toBe('warn')
  expect(statusParts(f('five_hour', 9, { projected: 45, lo: 12, hi: 73 })).tone).toBe('good')
})

test('the bar shows used, likely and the 80% range against the limit', async () => {
  const text = (parts: { kind: string; text: string }[]) => parts.map(p => `${p.kind}:${p.text.length}`).join(' ')
  // 0–125% in 5% cells, the limit mark after cell 20.
  expect(text(rangeBar({ p: 60, projected: 104, hi: 119 }))).toBe('used:12 likely:8 limit:1 likely:1 range:3 free:1')
  expect(text(rangeBar({ p: 30 }))).toBe('used:6 free:14 limit:1 free:5')
  // The small bar of the limits line: 10 cells of 12.5%.
  expect(text(rangeBar({ p: 57, projected: 101, hi: 127 }, 10))).toBe('used:5 likely:3 limit:1 range:2')
})
