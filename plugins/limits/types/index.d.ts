export type Verdict = 'ok' | 'slow' | 'hold'

export type ForecastView = {
  kind: string
  label: string
  p: number
  msToReset?: number
  rate?: number
  rateBasis: string
  msToLimit?: number
  projected?: number
  learned?: number
  pace?: number
  perDayLeft?: number
  verdict: Verdict
  headline: string
}

export type View = {
  updatedAt: number
  overall: Verdict
  /** Identifies the current warning, so "Hide" lasts until it changes. */
  warningKey: string
  forecasts: ForecastView[]
  tips: string[]
  /** Window kinds whose token→percent conversion is learned. */
  calibrated: string[]
  history: {
    scanning: boolean
    days: number
    files: number
    skipped: number
    busiest: string[]
    /** Estimated weekly percent of the past weeks, most recent first. */
    pastWeeks: number[]
  }
  folder: string
}

declare module 'claude-code' {
  interface PluginState {
    limits: { view: View | null; hiddenKey: string }
  }
}
