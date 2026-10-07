import { expect, test } from 'claude-code/testing'

import {
  addToBuckets, calibrate, DAY, evaluate, forecast, hitReadings, HOUR, mergeHits, parseTranscript, profile, rangeBar, statusParts, statusText, suggestions, dur, units,
  usageIndex, weightCheck,
} from '../hooks/model'
import type { Buckets, Forecast, ForecastLog, Reading, Turn } from '../hooks/model'
import { quantile, ratioFit } from '../hooks/stats'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const close = (x: number | undefined, v: number) => expect(Math.abs((x ?? NaN) - v)).toBeLessThan(1e-6)
const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'

/** A turn worth `u` units. */
const turnU = (t: number, u: number, model = SONNET, sub = false): Turn =>
  ({ t, model, in: 0, cw: 0, cr: 0, out: (u * 1e6) / (5 * (model === OPUS ? 5 : 3)), sub })

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

test('parses limit hits, compactions, turn durations, effort and attribution', async () => {
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
      message: { id: 'x', model: OPUS, content: [], usage: { input_tokens: 1, output_tokens: 1 } },
    }),
  ].join('\n')
  const tr = parseTranscript(text)
  expect(tr.hits).toEqual([{ t: Date.parse('2026-09-30T10:59:00Z'), kind: 'five_hour', r: '2026-09-30T12:00:00.000Z', tries: 2 }])
  expect(tr.compactions).toEqual([{ t: Date.parse('2026-09-30T09:00:00Z'), trigger: 'manual', pre: 389929, post: 11405 }])
  expect(tr.durations).toEqual([{ t: Date.parse('2026-09-30T09:10:00Z'), ms: 23230 }])
  expect(tr.turns.length).toBe(1)
  expect(tr.turns[0]).toMatchObject({ effort: 'medium', attr: ['skill:code-review', 'agent:Explore'], thinkMs: 700, aborted: true })
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
})

test('weights tokens like API list prices', async () => {
  const base = { in: 0, cw: 0, cr: 0, out: 1_000_000 }
  expect(units({ model: OPUS, ...base })).toBe(25)
  expect(units({ model: SONNET, ...base })).toBe(15)
})

test('usage index sums ranges and prorates the edge buckets', async () => {
  const b: Buckets = {}
  addToBuckets(b, turnU(NOW, 4))
  addToBuckets(b, turnU(NOW + HOUR, 8, OPUS, true))
  const between = usageIndex(b)
  expect(between(NOW - HOUR, NOW + 2 * HOUR)).toEqual([12, 8, 8])
  // Half of the first 15-minute bucket.
  close(between(NOW, NOW + 7.5 * 60_000)[0], 2)
  close(between(NOW + 7.5 * 60_000, NOW + HOUR + 60_000)[0], 2 + 8 / 15)
})

test('stats: quantile interpolates, ratio fit gives k and a standard error', async () => {
  expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
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

test('the Opus weight check finds Opus costing more than assumed', async () => {
  const b: Buckets = {}
  const readings: Reading[] = []
  const r = new Date(NOW + HOUR).toISOString()
  let p = 0
  const t0 = NOW - 9 * HOUR
  readings.push({ t: t0, kind: 'five_hour', p, r })
  for (let i = 0; i < 8; i++) {
    const opus = [1, 4, 2, 6, 0.5, 3, 5, 1.5][i]!
    const other = [5, 1, 3, 2, 6, 4, 0.5, 2][i]!
    addToBuckets(b, turnU(t0 + i * HOUR + 30 * 60_000, opus, OPUS))
    addToBuckets(b, turnU(t0 + i * HOUR + 31 * 60_000, other))
    p += 0.5 * (1.5 * opus + other)
    readings.push({ t: t0 + (i + 1) * HOUR, kind: 'five_hour', p, r })
  }
  const check = weightCheck(readings, usageIndex(b), NOW)
  close(check?.ratio, 1.5)
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
})

test('no usage lately → OK, and weekly gives a per-day budget', async () => {
  const f = forecast({ kind: 'seven_day', p: 40, resetsAt: NOW + 3.5 * DAY, now: NOW, cal: { k: 2 }, between: usageIndex({}), readings: [] })
  expect(f.verdict).toBe('ok')
  expect(Math.round(f.pace ?? 0)).toBe(50)
  expect(Math.round(f.perDayLeft ?? 0)).toBe(17)
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
  expect(f.risk).toBe(0.6)
  expect(f.verdict).toBe('slow')
  // Half the past weeks running out is a coin toss, not "more likely than not".
  const four: Buckets = Object.fromEntries(Object.entries(b).filter(([k]) => Number(k) > NOW - 29 * DAY))
  const even = forecast({ kind: 'seven_day', p: 60, resetsAt: NOW + 3.5 * DAY, now: NOW, cal: { k: 1 }, between: usageIndex(four), readings: [], prof: profile(four, NOW) })
  expect(even.samples).toBe(4)
  expect(even.risk).toBe(0.5)
  expect(even.verdict).toBe('ok')
  // A pattern forecast alone never says "hold on".
  expect(f.verdict === 'hold').toBe(false)
})

test('forecasts are scored once their window has reset', async () => {
  const r1 = '2026-10-01T00:00:00Z'
  const r2 = '2026-10-02T00:00:00Z'
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
  close(q.mae, 7.5)
  close(q.bias, -7.5)
  expect(q.coverage).toBe(0.5)
  close(q.brier, 0.085)
  close(q.skill, -0.5)
})

test('suggestions point at the cause', async () => {
  const b: Buckets = {}
  addToBuckets(b, turnU(NOW - HOUR, 25, OPUS, true))
  const between = usageIndex(b)
  const f = forecast({ kind: 'five_hour', p: 96, resetsAt: NOW + HOUR, now: NOW, between, readings: [] })
  const ids = suggestions({ forecasts: [f], between, now: NOW, context: 150_000 }).map(t => t.id)
  expect(ids).toEqual(['context', 'model', 'subagents', 'break'])
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

test('status line shows the same fields whatever the verdict, a dash for what is unknown', async () => {
  const f = (kind: string, p: number, extra: object) => ({ kind, label: kind, p, rateBasis: '', headline: '', verdict: 'ok' as const, ...extra })
  expect(statusText([])).toBe(undefined)
  expect(statusText([
    f('five_hour', 42, { msToReset: 2.5 * HOUR, projected: 68, lo: 61, hi: 77, risk: 0 }),
    f('seven_day', 61, { msToReset: 3 * DAY, projected: 104, lo: 88, hi: 119, risk: 0.75, verdict: 'slow' }),
  ])).toBe('5h 42% ↻ 2h30 → 68% (61–77) risk 0% ● OK   │   wk 61% ↻ 3d → 104% (88–119) risk 75% ● SLOW DOWN')
  expect(statusText([f('five_hour', 30, { msToReset: 3 * HOUR })])).toBe('5h 30% ↻ 3h00 → – risk – ● OK')
  const at = new Date(2026, 9, 7, 14, 2).getTime()
  expect(statusText([f('five_hour', 30, { msToReset: 3 * HOUR })], at)).toBe('5h 30% ↻ 3h00 → – risk – ● OK   · 14:02')
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
