import { expect, test } from 'claude-code/testing'

import {
  addCalib, addToBuckets, DAY, forecast, HOUR, parseTranscript, ratio, suggestions, units, unitsBetween,
} from '../hooks/model'
import type { HourBuckets } from '../hooks/model'

const NOW = Date.parse('2026-10-07T12:00:00Z')

test('parses a transcript once per message, skipping duplicates and non-usage lines', async () => {
  const msg = (id: string, ts: string, out: number, side = false) =>
    JSON.stringify({
      type: 'assistant', timestamp: ts, isSidechain: side,
      message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: out } },
    })
  const text = [msg('a', '2026-10-07T10:00:00Z', 50), msg('a', '2026-10-07T10:00:01Z', 50), msg('b', '2026-10-07T10:05:00Z', 20, true), '{"type":"user"}', 'not json'].join('\n')
  const turns = parseTranscript(text)
  expect(turns.length).toBe(2)
  expect(turns[1]?.sub).toBe(true)
  expect(turns[0]?.out).toBe(50)
})

test('weights tokens by type and model', async () => {
  const base = { in: 0, cw: 0, cr: 0, out: 1_000_000 }
  expect(units({ model: 'claude-opus-5-5', ...base })).toBe(25)
  expect(units({ model: 'claude-sonnet-5-5', ...base })).toBe(15)
})

test('calibration needs a few points before it gives a ratio', async () => {
  let c = addCalib({}, 'five_hour', 1, 2)
  expect(ratio(c, 'five_hour')).toBe(undefined)
  c = addCalib(c, 'five_hour', 3, 4)
  expect(ratio(c, 'five_hour')).toBe(4 / 6)
})

test('5-hour window: current speed runs out before reset → slow down or hold on', async () => {
  const b: HourBuckets = {}
  // 10 units in the last hour; with k = 2 that is 20%/h.
  addToBuckets(b, { t: NOW - 30 * 60_000, model: 'x', in: 0, cw: 0, cr: 0, out: 2_000_000 / 3 * 1 })
  expect(Math.round(unitsBetween(b, NOW - HOUR, NOW))).toBe(10)
  const f = forecast({ kind: 'five_hour', p: 50, resetsAt: NOW + 3 * HOUR, now: NOW, k: 2, buckets: b, readings: [] })
  expect(Math.round(f.rate ?? 0)).toBe(20)
  expect(Math.round((f.msToLimit ?? 0) / 60_000)).toBe(150)
  expect(f.verdict).toBe('slow')

  const g = forecast({ kind: 'five_hour', p: 90, resetsAt: NOW + 3 * HOUR, now: NOW, k: 2, buckets: b, readings: [] })
  expect(g.verdict).toBe('hold')
})

test('no usage lately → OK, and weekly gives a per-day budget', async () => {
  const f = forecast({ kind: 'seven_day', p: 40, resetsAt: NOW + 3.5 * DAY, now: NOW, k: 2, buckets: {}, readings: [] })
  expect(f.verdict).toBe('ok')
  expect(Math.round(f.pace ?? 0)).toBe(50)
  expect(Math.round(f.perDayLeft ?? 0)).toBe(17)
})

test('falls back to readings when not calibrated yet', async () => {
  const readings = [
    { t: NOW - 50 * 60_000, kind: 'five_hour', p: 40, r: 'R' },
    { t: NOW - 5 * 60_000, kind: 'five_hour', p: 55, r: 'R' },
  ]
  const f = forecast({ kind: 'five_hour', p: 55, resetsAt: NOW + 4 * HOUR, now: NOW, buckets: {}, readings, r: 'R' })
  expect(Math.round(f.rate ?? 0)).toBe(20)
  expect(f.verdict).toBe('slow')
})

test('suggestions point at the cause', async () => {
  const b: HourBuckets = {}
  addToBuckets(b, { t: NOW - HOUR, model: 'claude-opus-5-5', in: 0, cw: 0, cr: 0, out: 1_000_000, sub: true })
  const f = forecast({ kind: 'five_hour', p: 96, resetsAt: NOW + HOUR, now: NOW, buckets: b, readings: [] })
  const tips = suggestions({ forecasts: [f], buckets: b, now: NOW, context: 180_000 })
  expect(tips.some(t => t.includes('/compact'))).toBe(true)
  expect(tips.some(t => t.includes('Sonnet'))).toBe(true)
  expect(tips.some(t => t.includes('Subagents'))).toBe(true)
})
