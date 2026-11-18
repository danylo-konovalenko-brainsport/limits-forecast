import { expect, test } from 'claude-code/testing'

import { reportText } from '../hooks/report'
import type { View } from '../types'

const T = Date.parse('2026-10-07T12:00:00Z')
const DAY = 24 * 3_600_000

const base: View = {
  updatedAt: T,
  reportedAt: T,
  overall: 'ok',
  warningKey: 'ok:',
  forecasts: [],
  tips: [],
  learned: {
    calib: [{ kind: 'five_hour', label: '5-hour', n: 1, points: 1.2 }],
    weights: [{ family: 'fable', label: 'Fable' }],
    tuning: [{ kind: 'five_hour', label: '5-hour', tau: 3_600_000, halfLife: 14 * DAY, scale: 1, bias: 1, n: 4, independent: 2 }],
  },
  quality: [{ kind: 'five_hour', label: '5-hour', n: 0, windows: 0, nInterval: 0, nRisk: 0, correction: 1 }],
  history: { scanning: false, days: 3, files: 4, skipped: 0, busiest: [], pastWeeks: [], hits: { count: 0, fiveHour: 0, weekly: 0, blockedHours: 0 } },
  folder: '/cfg/limit-metrics',
}

test('the report says what it is still waiting for, then what it learned', async () => {
  const early = reportText(base)
  expect(early).toContain('No limit reading yet')
  expect(early).toContain('learning tokens → %: 1.2 of 3 points seen')
  expect(early).toContain('Fable cost  – needs more mixed Fable and other use to check')
  expect(early).toContain('tunes itself from 10 non-overlapping replayed forecasts (2 so far)')
  expect(early).toContain('0 forecasts checked so far')
  expect(early).toContain('nothing to change right now')
  expect(early).toContain('3 days from 4 transcripts')

  const later = reportText({
    ...base,
    forecasts: [{
      kind: 'seven_day', label: 'Weekly', p: 61, msToReset: 3 * DAY, projected: 104, lo: 88, hi: 119, risk: 0.75, samples: 4, sampleUnit: 'weeks',
      rate: 1.2, rateBasis: 'your last 24 hours', pace: 57, perDayLeft: 13, verdict: 'slow', headline: '',
    }],
    tips: [{ id: 'budget', text: 'To last the week, keep to about 13% per day until the reset.' }],
    learned: {
      calib: [{ kind: 'five_hour', label: '5-hour', k: 2, se: 0.2, n: 7, points: 40 }],
      weights: [{ family: 'fable', label: 'Fable', ratio: 1.3, se: 0.05, n: 9, applied: true }, { family: 'opus', label: 'Opus', ratio: 1.02, se: 0.04, n: 9, applied: false }],
      tuning: [],
      regularity: { cv: 0.48, weeks: 4 },
    },
    quality: [{ kind: 'seven_day', label: 'Weekly', n: 12, windows: 3, mae: 9.5, bias: 8, coverage: 0.6, nInterval: 12, width: 30, brier: 0.1, nRisk: 12, skill: -0.09, ratio: 0.7, correction: 0.7 }],
    history: { ...base.history, hits: { count: 2, fiveHour: 2, weekly: 0, blockedHours: 1.5, last: T } },
  })
  expect(later).toContain('Weekly        SLOW DOWN')
  expect(later).toContain('~104%  ·  80% range 88–119%  (from 4 past weeks)')
  expect(later).toContain('75% chance to run out before the reset')
  expect(later).toContain('1.2%/h over your last 24 hours')
  expect(later).toContain('57% by now · you are over by 4')
  expect(later).toContain('~13% a day left until the reset')
  expect(later).toContain('• To last the week')
  expect(later).toContain('tokens → % learned, ±10% (7 stretches)')
  expect(later).toContain('Fable cost  costs more of your limit than assumed (×1.30 ± 0.05), now counted so')
  expect(later).toContain('Opus cost   weighted as assumed (×1.02 ± 0.04)')
  expect(later).toContain('off by ±9.5 pts · tends to run high · forecasts now scaled ×0.70 · range held 60% (aim 80%) · 9% worse than "speed stays the same" · risk score 0.10 (0 best, 0.25 coin toss) · 12 checked over 3 windows')
  expect(later).toContain('2× 5-hour · 1.5 h blocked')
  expect(later).toContain('vary by ±48% from week to week (4 weeks)')

  // A model's own weekly window reads like the week, plus its place in it.
  const fable = reportText({
    ...base,
    forecasts: [{ kind: 'seven_day_fable', label: 'Fable', p: 49, msToReset: 2 * DAY, perDayLeft: 25.5, share: { used: 25, allowance: 50 }, rateBasis: 'your last 24 hours', verdict: 'ok', headline: '' }],
  })
  expect(fable).toContain('Fable         OK')
  expect(fable).toContain('per day     ~26% a day left until the reset')
  expect(fable).toContain('of the week Fable may take 50% of the weekly limit and has taken 25%')
})
