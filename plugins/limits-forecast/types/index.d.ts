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
  /** The scored-bias correction applied to k, when not 1. */
  correction?: number
  /** A model's own weekly window: percent of the shared weekly limit the model may take and has taken. */
  share?: { used: number; allowance: number }
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
  /** `se` is an assumed ±25% until 3 stretches give a measured one. */
  seAssumed?: boolean
  /** Re-learned from recent stretches only, after a change from this time on. */
  changedAt?: number
}

/** A model family's observed cost against the limit, relative to its assumed weight (1 = as assumed). */
export type WeightView = {
  family: string
  label: string
  ratio?: number
  se?: number
  n?: number
  applied?: boolean
}

/** Forecast settings learned by replaying past weeks. */
export type TuningView = {
  kind: string
  label: string
  tau: number
  halfLife: number
  scale: number
  bias: number
  n: number
  independent: number
  gain?: number
  coverage0?: number
  coverage?: number
}

export type QualityView = {
  kind: string
  label: string
  n: number
  /** Distinct windows among the scored forecasts. */
  windows: number
  mae?: number
  bias?: number
  coverage?: number
  nInterval: number
  width?: number
  brier?: number
  nRisk: number
  skill?: number
  /** Σ actual ÷ Σ forecast increase of the scored forecasts. */
  ratio?: number
  /** What k is scaled by after the scored bias; 1 for none. */
  correction: number
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
    /** The weight check of each model family in use (Opus, Fable). */
    weights: WeightView[]
    /** Forecast settings learned by replaying past weeks, per window. */
    tuning: TuningView[]
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
    'limits-forecast': { view: View | null; hiddenKey: string; ctx: { tokens: number; window: number } | null }
  }
}
