import { expect, test } from 'claude-code/testing'

import { DAY, HOUR } from '../hooks/model'
import type { Transcript, Turn } from '../hooks/model'
import { blockedMs, buildExport, csv, emptyLog, forecastEntry, limitHits, parseLog, projectOf, rollupTranscript, tipFollowed } from '../hooks/retro'
import type { LoggedEvent, LoggedTurn } from '../hooks/retro'

const T = new Date(2026, 9, 7, 10, 20).getTime()
const only = (turns: Turn[], more: Partial<Transcript> = {}): Transcript => ({ turns, hits: [], compactions: [], durations: [], ...more })

test('rolls a transcript up per day: tokens per model, tool calls, active quarter-hours', async () => {
  const turns: Turn[] = [
    { t: T, model: 'opus', in: 1, cw: 2, cr: 3, out: 4, tools: ['Bash', 'Read'], effort: 'high', attr: ['skill:review'], thinkMs: 500 },
    { t: T + 5 * 60_000, model: 'opus', in: 1, cw: 0, cr: 0, out: 1, sub: true, tools: ['Bash'] },
    { t: T + HOUR, model: 'sonnet', in: 0, cw: 0, cr: 0, out: 10 },
  ]
  const hit = { t: T + 2 * HOUR, kind: 'five_hour', r: new Date(T + 3 * HOUR).toISOString(), tries: 3 }
  const row = rollupTranscript(only(turns, { hits: [hit], durations: [{ t: T, ms: 20_000 }], compactions: [{ t: T, trigger: 'auto', pre: 9, post: 1 }] }))['2026-10-07']!
  expect(row.m.opus).toEqual([2, 2, 2, 3, 5, 1])
  expect(row.tools).toEqual({ Bash: 2, Read: 1 })
  expect(row.q).toEqual([41, 45])
  expect(row.effort?.high?.[0]).toBe(1)
  expect(row.attr?.['skill:review']?.[0]).toBe(1)
  expect(row.thinkMs).toBe(500)
  expect(row.dur).toEqual([1, 20_000])
  expect(row.hits).toEqual([hit])
  expect(row.compact?.length).toBe(1)
})

test('the project is the last part of the cwd, else the transcript folder', async () => {
  expect(projectOf('{"cwd":"C:\\\\projects\\\\git\\\\app"}', '/c/projects/x/s.jsonl')).toBe('app')
  expect(projectOf('{}', '/cfg/projects/C--projects-app/s.jsonl')).toBe('C--projects-app')
})

test('log lines round-trip, and a limit hit counts the time blocked until reset', async () => {
  const r = new Date(T + 2 * HOUR).toISOString()
  const text = [
    JSON.stringify({ t: T, k: 'r', w: 'five_hour', p: 99, r }),
    JSON.stringify({ t: T + HOUR, k: 'r', w: 'five_hour', p: 100, r }),
    JSON.stringify(forecastEntry({ t: T, kind: 'five_hour', r, p: 99, pt: 104, risk: 0.8 })),
    JSON.stringify({ t: T, k: 't', m: 'opus', i: 1, cw: 0, cr: 0, o: 2, s: 0, x: 5000, d: 1200, a: 1 }),
    JSON.stringify({ t: T, k: 'e', e: 'tip', id: 'model' }),
  ].join('\n')
  const log = parseLog(text, 'abc')
  expect(log.forecasts[0]).toEqual({ t: T, kind: 'five_hour', r, p: 99, pt: 104, risk: 0.8 })
  expect(log.turns[0]).toEqual({ t: T, s: 'abc', m: 'opus', i: 1, cw: 0, cr: 0, o: 2, sub: false, x: 5000, d: 1200, a: true })
  expect(log.events[0]).toEqual({ t: T, e: 'tip', id: 'model', s: 'abc' })
  const hits = limitHits(log.readings)
  expect(hits.length).toBe(1)
  expect(blockedMs(hits[0]!)).toBe(HOUR)
  // The same window refused in a transcript counts once, with its retries.
  const both = limitHits(log.readings, [{ t: T + 30 * 60_000, kind: 'five_hour', r, tries: 4 }])
  expect(both.length).toBe(1)
  expect(both[0]?.tries).toBe(4)
  expect(blockedMs(both[0]!)).toBe(1.5 * HOUR)
})

test('a tip counts as followed when the session acted on it', async () => {
  const turn = (t: number, m: string, extra: Partial<LoggedTurn> = {}): LoggedTurn =>
    ({ t, s: 'a', m, i: 0, cw: 0, cr: 0, o: 1000, sub: false, a: false, ...extra })
  const tip = (id: string): LoggedEvent => ({ t: T, s: 'a', e: 'tip', id })
  const turns = [turn(T - 60_000, 'claude-opus-5-5', { x: 150_000 }), turn(T + 10 * 60_000, 'claude-sonnet-5-5', { x: 40_000 })]
  expect(tipFollowed(tip('model'), turns, [])).toBe(true)
  expect(tipFollowed(tip('context'), turns, [])).toBe(true)
  expect(tipFollowed(tip('break'), turns, [])).toBe(false)
  expect(tipFollowed(tip('budget'), turns, [])).toBe(undefined)
  // Another session's turns do not count.
  expect(tipFollowed({ ...tip('model'), s: 'b' }, turns, [])).toBe(false)
})

test('the export has CSV tables and a summary', async () => {
  const log = emptyLog()
  const r = new Date(T - HOUR).toISOString()
  log.readings.push({ t: T - 2 * HOUR, kind: 'five_hour', p: 100, r })
  log.events.push({ t: T, s: 'a', e: 'warn' }, { t: T, s: 'a', e: 'hide' })
  const weekly = { t: T - DAY, kind: 'seven_day', r: new Date(T - DAY + 2 * HOUR).toISOString(), tries: 2 }
  const days = rollupTranscript(only(
    [{ t: T, model: 'claude-opus-5-5', in: 0, cw: 0, cr: 1_000_000, out: 1_000_000, attr: ['mcp:asana'], effort: 'high' }],
    { hits: [weekly], compactions: [{ t: T, trigger: 'manual', pre: 300_000, post: 10_000 }] },
  ))
  const files = buildExport({ log, rollups: [{ version: 1, files: { '/p/s.jsonl': { project: 'app', days } } }], now: T })
  expect(Object.keys(files).sort()).toEqual([
    'active-daily.csv', 'attribution-daily.csv', 'compactions.csv', 'effort-daily.csv', 'events.csv', 'forecasts.csv', 'limit-hits.csv', 'limits.csv',
    'summary.json', 'tips.csv', 'tools-daily.csv', 'turns.csv', 'usage-daily.csv',
  ])
  expect(files['attribution-daily.csv']).toContain('2026-10-07,app,mcp,asana,1,25.5')
  expect(files['limit-hits.csv']).toContain(',Weekly,')
  expect(files['usage-daily.csv']).toContain('2026-10-07,app,claude-opus-5-5,1,0,0,1000000,1000000,0,25.5')
  const summary = JSON.parse(files['summary.json']!)
  expect(summary.usdEquivalent).toBe(25.5)
  expect(summary.limitHits.five_hour).toEqual({ count: 1, blockedHours: 1, retries: 0 })
  expect(summary.limitHits.seven_day).toEqual({ count: 1, blockedHours: 2, retries: 1 })
  expect(summary.compactions).toMatchObject({ manual: 1, auto: 0, medianTokensBefore: 300_000 })
  expect(summary.byEffort.high.usd).toBe(25.5)
  expect(summary.warnings).toEqual({ shown: 1, hidden: 1, paneOpened: 0 })
  expect(csv(['a'], [['x,"y"']])).toBe('a\n"x,""y"""\n')
})
