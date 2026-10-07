export type Verdict = 'ok' | 'slow' | 'hold'

export type ForecastView = {
  kind: string
  label: string
  p: number
  msToReset?: number
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
  samples?: number
  sampleUnit?: 'days' | 'weeks'
  baseline?: number
  pace?: number
  perDayLeft?: number
  verdict: Verdict
  headline: string
}

export type CalibView = {
  kind: string
  label: string
  k?: number
  se?: number
  n: number
  points: number
}

export type QualityView = {
  kind: string
  label: string
  n: number
  mae?: number
  bias?: number
  coverage?: number
  nInterval: number
  width?: number
  brier?: number
  nRisk: number
  skill?: number
}

export type View = {
  updatedAt: number
  /** When Claude Code last reported the limits (they come with responses). */
  reportedAt?: number
  overall: Verdict
  /** Identifies the current warning, so "Hide" lasts until it changes. */
  warningKey: string
  forecasts: ForecastView[]
  tips: { id: string; text: string }[]
  learned: {
    calib: CalibView[]
    /** Observed Opus cost relative to the assumed weight (1 = as assumed). */
    opusCheck?: { ratio: number; se: number; n: number }
    /** Week-to-week variation of usage (coefficient of variation). */
    regularity?: { cv: number; weeks: number }
  }
  quality: QualityView[]
  history: {
    scanning: boolean
    days: number
    files: number
    skipped: number
    busiest: string[]
    /** Estimated weekly percent of the past weeks, most recent first. */
    pastWeeks: number[]
    /** Times a limit ran out, from transcripts and live readings. */
    hits: { count: number; fiveHour: number; weekly: number; blockedHours: number; last?: number }
  }
  folder: string
}

declare module 'claude-code' {
  interface PluginState {
    limits: { view: View | null; hiddenKey: string }
  }
}
