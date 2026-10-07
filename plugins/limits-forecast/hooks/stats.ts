// Small statistics helpers, pure.

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : NaN)

/** Sample quantile, linear interpolation between order statistics (R type 7). */
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b)
  if (s.length === 0) return NaN
  const h = (s.length - 1) * q
  const lo = Math.floor(h)
  return s[lo]! + (h - lo) * ((s[Math.min(lo + 1, s.length - 1)] ?? s[lo]!) - s[lo]!)
}

/** Coefficient of variation (sample sd / mean). */
export function cv(xs: number[]): number | undefined {
  if (xs.length < 2) return undefined
  const m = mean(xs)
  if (!(m > 0)) return undefined
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(v) / m
}

/** Ordinary least-squares slope of y on x. */
export function slope(xs: number[], ys: number[]): number | undefined {
  if (xs.length < 2) return undefined
  const mx = mean(xs)
  const my = mean(ys)
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my)
    sxx += (xs[i]! - mx) ** 2
  }
  return sxx > 0 ? sxy / sxx : undefined
}

export type Pair = { y: number; x: number; w: number }

/**
 * Ratio estimator k = Σw·y / Σw·x: weighted least squares through the origin
 * when Var(y) ∝ x. Standard error from the residuals; undefined below 3 pairs.
 */
export function ratioFit(pairs: Pair[]): { k: number; se?: number } | undefined {
  const sy = pairs.reduce((a, p) => a + p.w * p.y, 0)
  const sx = pairs.reduce((a, p) => a + p.w * p.x, 0)
  if (!(sx > 0)) return undefined
  const k = sy / sx
  const n = pairs.length
  if (n < 3) return { k }
  const sw = pairs.reduce((a, p) => a + p.w, 0)
  const s2 = (pairs.reduce((a, p) => a + (p.w * (p.y - k * p.x) ** 2) / p.x, 0) / sw) * (n / (n - 1))
  const varK = (s2 * pairs.reduce((a, p) => a + p.w * p.w * p.x, 0)) / (sx * sx)
  return { k, se: Math.sqrt(varK) }
}

/**
 * y = a·x1 + b·x2 without intercept, weighted least squares (weights w / (x1+x2),
 * i.e. Var(y) ∝ x). Returns a/b with a delta-method standard error.
 */
export function ratioOfTwo(rows: { y: number; x1: number; x2: number; w: number }[]): { ratio: number; se: number } | undefined {
  const rs = rows.filter(r => r.x1 + r.x2 > 0)
  if (rs.length < 6) return undefined
  let s11 = 0, s12 = 0, s22 = 0, s1y = 0, s2y = 0
  for (const r of rs) {
    const w = r.w / (r.x1 + r.x2)
    s11 += w * r.x1 * r.x1
    s12 += w * r.x1 * r.x2
    s22 += w * r.x2 * r.x2
    s1y += w * r.x1 * r.y
    s2y += w * r.x2 * r.y
  }
  const det = s11 * s22 - s12 * s12
  // Needs both kinds of usage to vary independently, or the split is unknowable.
  if (!(det > 1e-9 * s11 * s22)) return undefined
  const a = (s22 * s1y - s12 * s2y) / det
  const b = (s11 * s2y - s12 * s1y) / det
  if (!(a > 0) || !(b > 0)) return undefined
  let rss = 0
  for (const r of rs) rss += (r.w / (r.x1 + r.x2)) * (r.y - a * r.x1 - b * r.x2) ** 2
  const s2 = rss / (rs.length - 2)
  const vA = (s2 * s22) / det
  const vB = (s2 * s11) / det
  const cAB = (-s2 * s12) / det
  const ratio = a / b
  const v = vA / (b * b) + (a * a * vB) / b ** 4 - (2 * a * cAB) / b ** 3
  return { ratio, se: Math.sqrt(Math.max(0, v)) }
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, error below 1.5e-7). */
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x)
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2
}

/** Silverman's rule-of-thumb bandwidth for a Gaussian kernel. */
export function bandwidth(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
  const iqr = (quantile(xs, 0.75) - quantile(xs, 0.25)) / 1.34
  return 0.9 * (iqr > 0 ? Math.min(sd, iqr) : sd) * Math.pow(xs.length, -0.2)
}

/**
 * P(X ≥ x) from a Gaussian kernel density estimate of the samples, each kernel
 * widened by `extraSd` (another, independent error source). With no spread at
 * all it is the plain share of samples at or above x.
 */
export function kdeTail(xs: number[], x: number, extraSd = 0): number {
  const s = Math.hypot(bandwidth(xs), extraSd)
  if (!(s > 0)) return xs.filter(v => v >= x).length / xs.length
  return mean(xs.map(v => 1 - normCdf((x - v) / s)))
}

/**
 * The q-quantile of the same kernel density estimate as `kdeTail`, found by
 * bisection, so a range and a risk from it always agree. With no spread at
 * all it is the plain sample quantile.
 */
export function kdeQuantile(xs: number[], q: number, extraSd = 0): number {
  const s = Math.hypot(bandwidth(xs), extraSd)
  if (!(s > 0)) return quantile(xs, q)
  let lo = Math.min(...xs) - 6 * s
  let hi = Math.max(...xs) + 6 * s
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (mean(xs.map(v => normCdf((mid - v) / s))) < q) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}
