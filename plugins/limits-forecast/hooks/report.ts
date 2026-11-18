// The pane's words, pure: the rows under each limit, the learning, quality and
// history sections, and the same report as plain text where no pane is drawn.

import { DAY, dur, fmtPct, fmtRange, HOUR, isWeekly, MIN_REPLAY, rangeBar, VERDICT_TEXT } from './model'
import type { Hit } from './model'
import { blockedMs } from './retro'
import type { View } from '../types'

export type Row = { label: string; value: string; dim?: boolean }

export const LEGEND = '█ used   ▓ forecast by the reset   ▒ 80% range above it   │ the limit (100%)'

const pct1 = (x: number) => `${Math.round(x * 100)}%`
const num = (x: number, d = 1) => x.toFixed(d)

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export function clockTime(t: number, withDay: boolean) {
  const d = new Date(t)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return withDay ? `${DAYS[d.getDay()]} ${hm}` : hm
}

/** One limit's rows, as the pane and the text report show them. */
export function forecastRows(f: View['forecasts'][number], v: View): Row[] {
  const week = isWeekly(f.kind)
  const rows: Row[] = [
    { label: 'used', value: `${fmtPct(f.p)} now` },
    {
      label: 'resets',
      value: f.msToReset !== undefined ? `in ${dur(f.msToReset)} · ${clockTime(v.updatedAt + f.msToReset, week)}` : '–',
      dim: f.msToReset === undefined,
    },
    {
      label: 'at reset',
      value:
        f.projected === undefined
          ? '– learning how your tokens map to percent'
          : `~${fmtPct(f.projected)}` +
            (f.lo !== undefined && f.hi !== undefined
              ? `  ·  80% range ${fmtRange(f.lo, f.hi)}  (from ${f.samples} past ${f.sampleUnit})`
              : `  ·  range needs 3 comparable past ${week ? 'weeks' : 'days'}`),
      dim: f.projected === undefined,
    },
    { label: 'risk', value: f.risk !== undefined ? `${pct1(f.risk)} chance to run out before the reset` : '– comes with the range', dim: f.risk === undefined },
    { label: 'speed', value: f.rate !== undefined ? `${f.rate.toFixed(1)}%/h over ${f.rateBasis}` : `– ${f.rateBasis}`, dim: f.rate === undefined },
    {
      label: 'even pace',
      value: f.pace !== undefined ? `${fmtPct(f.pace)} by now · you are ${f.p <= f.pace ? 'under' : 'over'} by ${Math.round(Math.abs(f.p - f.pace))}` : '–',
      dim: f.pace === undefined,
    },
  ]
  if (week) rows.push({ label: 'per day', value: f.perDayLeft !== undefined ? `~${fmtPct(f.perDayLeft)} a day left until the reset` : '–', dim: f.perDayLeft === undefined })
  if (f.share) rows.push({ label: 'of the week', value: `${f.label} may take ${fmtPct(f.share.allowance)} of the weekly limit and has taken ${fmtPct(f.share.used)}` })
  return rows
}

/** The pane's text below the limits: the same for the pane and for `/limits-forecast` where no pane shows. */
export function report(v: View) {
  const hist = v.history
  const c = (x: View['learned']['calib'][number]): Row => ({
    label: x.label,
    value:
      (x.k === undefined
        ? `learning tokens → %: ${String(Math.round(Math.min(x.points, 3) * 10) / 10)} of 3 points seen`
        : x.seAssumed
          ? `tokens → % learned, ±${pct1((x.se ?? 0) / x.k)} assumed until 3 stretches (${x.n} so far)`
          : `tokens → % learned, ±${pct1((x.se ?? 0) / x.k)} (${x.n} stretches)`) +
      (x.changedAt !== undefined ? ` · re-learned after a change on ${clockTime(x.changedAt, true)}` : ''),
    dim: x.k === undefined,
  })
  return {
    note:
      v.forecasts.length > 0
        ? `As of ${v.reportedAt !== undefined ? clockTime(v.reportedAt, false) : '–'} · updates with every response`
        : 'No limit reading yet: it arrives with the next response (subscription plans only).',
    sections: [
      {
        title: 'Learning',
        rows: [
          ...v.learned.calib.map(c),
          ...v.learned.weights.map(w => ({ label: `${w.label} cost`, value: weightText(w), dim: w.ratio === undefined })),
          ...v.learned.tuning.map(t => ({ label: `${t.label} fit`, value: tuningText(t), dim: t.independent < MIN_REPLAY })),
          {
            label: 'your weeks',
            value: v.learned.regularity
              ? `vary by ±${pct1(v.learned.regularity.cv)} from week to week (${v.learned.regularity.weeks} weeks)`
              : '– needs 2 full weeks',
            dim: !v.learned.regularity,
          },
        ],
      },
      { title: 'Forecast quality · last 4 weeks', rows: v.quality.map(q => ({ label: q.label, value: qualityText(q), dim: q.n < 3 })) },
      {
        title: 'History',
        rows: [
          {
            label: 'read',
            value: hist.scanning
              ? 'reading past sessions…'
              : `${hist.days} days from ${hist.files} transcripts${hist.skipped ? ` (${hist.skipped} could not be read)` : ''}`,
          },
          { label: 'limit hits', value: hist.hits.count ? hitText(hist.hits) : '– none in your history', dim: !hist.hits.count },
          { label: 'busiest', value: hist.busiest.length ? hist.busiest.join(', ') : '– needs a week', dim: !hist.busiest.length },
          {
            label: 'past weeks',
            value: hist.pastWeeks.length ? `${hist.pastWeeks.map(p => fmtPct(p)).join(' · ')}  (latest first, estimated)` : '–',
            dim: !hist.pastWeeks.length,
          },
        ],
      },
    ] as { title: string; rows: Row[] }[],
    footer: `Data: ${v.folder}  ·  /limits-forecast export writes CSVs for a retrospective`,
  }
}

/** The pane as plain text, for surfaces that draw no plugin panes (VS Code). */
export function reportText(v: View | null): string {
  if (!v) return 'Usage limits: collecting data…'
  const rep = report(v)
  const line = (r: Row) => `  ${r.label.padEnd(12)}${r.value}`
  const out = [rep.note, '']
  for (const f of v.forecasts) {
    out.push(`${f.label.padEnd(14)}${VERDICT_TEXT[f.verdict]}`, ' '.repeat(14) + rangeBar(f).map(p => p.text).join(''), ...forecastRows(f, v).map(line), '')
  }
  if (v.forecasts.length) out.push(LEGEND, '')
  out.push('Suggestions', ...(v.tips.length ? v.tips.map(t => `  • ${t.text}`) : ['  – nothing to change right now']), '')
  for (const sec of rep.sections) out.push(sec.title, ...sec.rows.map(line), '')
  out.push(rep.footer)
  return out.join('\n')
}

/** What a family's weight check found, in plain words. */
function weightText(w: View['learned']['weights'][number]): string {
  if (w.ratio === undefined || w.se === undefined) return `– needs more mixed ${w.label} and other use to check`
  const x = `×${num(w.ratio, 2)} ± ${num(w.se, 2)}`
  if (Math.abs(w.ratio - 1) <= 2 * w.se) return `weighted as assumed (${x})`
  return `${w.ratio > 1 ? 'costs more' : 'costs less'} of your limit than assumed (${x})${w.applied ? ', now counted so' : ', not yet precise enough to apply'}`
}

/** What the replay of past weeks learned, in plain words. */
function tuningText(t: View['learned']['tuning'][number]): string {
  if (t.independent < MIN_REPLAY) return `– tunes itself from ${MIN_REPLAY} non-overlapping replayed forecasts (${t.independent} so far)`
  const parts = [`bursts fade over ${dur(t.tau)}`, `recent ${Math.round(t.halfLife / DAY)} days count half`]
  if (t.gain !== undefined && t.gain > 0) parts.push(`${pct1(t.gain)} more accurate than the defaults`)
  if (t.bias !== 1) parts.push(`forecasts ×${num(t.bias, 2)} (they ran ${t.bias < 1 ? 'high' : 'low'})`)
  if (t.coverage !== undefined) {
    parts.push(
      t.scale === 1
        ? `range held ${pct1(t.coverage)} (aim 80%)`
        : `range ×${num(t.scale, 2)} so it held ${pct1(t.coverage)} instead of ${pct1(t.coverage0 ?? 0)} (aim 80%)`,
    )
  }
  return `${parts.join(' · ')}  (${t.n} replayed, ~${t.independent} independent)`
}

function qualityText(q: View['quality'][number]): string {
  if (q.n < 3) return `– ${q.n} forecasts checked so far, scores after 3 resets`
  const parts = [`off by ±${num(q.mae ?? 0)} pts`]
  if (q.bias !== undefined && Math.abs(q.bias) >= 3) parts.push(`tends to run ${q.bias > 0 ? 'high' : 'low'}`)
  if (q.correction !== 1) parts.push(`forecasts now scaled ×${num(q.correction, 2)}`)
  if (q.coverage !== undefined) parts.push(`range held ${pct1(q.coverage)} (aim 80%)`)
  if (q.skill !== undefined) parts.push(`${pct1(Math.abs(q.skill))} ${q.skill >= 0 ? 'better' : 'worse'} than "speed stays the same"`)
  if (q.brier !== undefined) parts.push(`risk score ${num(q.brier, 2)} (0 best, 0.25 coin toss)`)
  parts.push(`${q.n} checked over ${q.windows} ${q.windows === 1 ? 'window' : 'windows'}`)
  return parts.join(' · ')
}

export function hitSummary(hits: Hit[]): View['history']['hits'] {
  const n = (kind: string) => hits.filter(h => h.kind === kind).length
  return {
    count: hits.length,
    fiveHour: n('five_hour'),
    weekly: n('seven_day'),
    blockedHours: hits.reduce((a, h) => a + blockedMs(h), 0) / HOUR,
    ...(hits.length ? { last: hits[hits.length - 1]!.t } : {}),
  }
}

function hitText(h: View['history']['hits']): string {
  const kinds = [h.fiveHour ? `${h.fiveHour}× 5-hour` : '', h.weekly ? `${h.weekly}× weekly` : ''].filter(Boolean).join(', ')
  const last = h.last !== undefined ? ` · last ${clockTime(h.last, true)} ${new Date(h.last).getDate()}.${new Date(h.last).getMonth() + 1}.` : ''
  return `${kinds} · ${num(h.blockedHours)} h blocked${last}`
}
