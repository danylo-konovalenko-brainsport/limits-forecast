# limits-forecast

A Claude Code mod that forecasts your 5‑hour and weekly usage limits, and a model's own weekly limit where your plan has one (Fable's), learns your usage pattern and suggests what to change before you run out.

![Claude Code mod](https://img.shields.io/badge/Claude_Code-mod-D97757)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)

---

## What you get

### Limits line above the prompt

```
5h ███▓▓▒··│·· 42% ↻ 2h30 → 68% risk 0% ● OK   │   wk █████▓▓▓│▒▒ 61% ↻ 3d → 104% risk 75% ● SLOW DOWN   · 14:02   · ctx 84k/200k 42%
```

| Field | Meaning |
| --- | --- |
| `· 14:02` | When Claude Code last reported your limits. Claude Code gets them with each response, so they update when you send a message; usage in other sessions or on claude.ai shows up after your next one. |
| `· ctx 84k/200k 42%` | The current context: tokens the last response was answered over, out of the model's window. It shows even before the mod has a forecast. |
| `5h` / `wk` | The 5-hour window and the weekly window. |
| `fable` | A model's own weekly window, after the two, where your plan has one: what `/usage` shows as *Current week (Fable)*. It has the same fields and its own forecast, see [Model limits](#model-limits). |
| `███▓▓▒··│··` | A small version of the [pane's bar](#limits-pane), 0–125% in 10 cells. The first thing to go when the terminal is too narrow for the line. |
| `42%` | Used now, exactly as Claude Code reports it. |
| `↻ 2h30` | Time until the window resets (`1d 23h` beyond a day). |
| `→ 68%` | **Point forecast**: the expected percent at reset. The 80% range behind it is in the pane. |
| `risk 0%` | **Probability** of reaching 100% before the reset. |
| `OK` / `SLOW DOWN` / `HOLD ON` | The verdict (rules [below](#verdicts)). |

The fields are the same whatever the verdict. A `–` means *not known yet*, for example before the mod has learned enough. When the line is wider than the terminal it sheds, in this order: the bars, the context, the spacing, the time, the risk.

`/config` has three options for the mod. **Limits line** is `full`, `compact` or `off`: compact drops the bars, the time and the context, and shows the forecast and risk only while a window is not OK, `5h 42% ↻2h30 ●OK │ wk 61% ↻3d →104% risk 75% ●SLOW DOWN`. **Toasts** turns the toasts off. **Model limits** turns the models' own windows off, and with them the mod's only network call.

Colors:

- **Verdict:** OK green, SLOW DOWN yellow, HOLD ON red.
- **Forecast:** green, yellow when it is at 90% or more or its range reaches past 100%, red when it is over 100%. So a tight window stands out even while the verdict is OK.
- **Bar:** the used part in the verdict color, the rest dim.

When a window is under pressure, the warning headline, the top suggestions and two buttons appear under the line: **Hide** keeps the warning away until the situation changes, in every session (the line stays); **Details** opens the pane.

### `/limits-forecast` pane

```
5-hour   ████████▓▓▓▓▓▓▒·····│·····
  used          42% now
  resets        in 2h30 · 16:32
  at reset      ~68%  ·  80% range 61–77%  (from 12 past days)
  risk          0% chance to run out before the reset
  speed         9.1%/h over your last hour
  even pace     50% by now · you are under by 8
```

- **The bar** runs from 0 to 125% in 5% cells. `█` is used, `▓` runs up to the forecast at the reset, `▒` from there to the top of the 80% range, and `│` marks the limit at 100%. It's a fan chart in one row: it draws the side of the range that decides whether you hit the limit, and the numbers next to it give the whole range.
- **Suggestions** (see [below](#suggestions)).
- **Learning:** how many tokens make one percent and its standard error (or the assumed one, and whether it re-learned after a change), the weight check of each model family you use (Opus, Fable) and whether it's applied, what the replay tuned per window, and how regular your weeks are. Each row says what data it is still waiting for.
- **Forecast quality:** the [scores](#how-it-scores-itself) in plain words, and the [correction](#10-scored-correction) they led to.
- **History:** transcripts read, your past limit hits and hours blocked, your busiest days, and your past weeks in percent.

#### Model limits

Some plans give a model a weekly limit of its own on top of the shared one: `/usage` shows it as *Current week (Fable)*. The mod shows it as a third window, in the line and in the pane:

```
Fable         OK
  used          49% now
  resets        in 2d · Fri 14:00
  at reset      ~81%  ·  80% range 66–97%  (from 4 past weeks)
  ...
  per day       ~26% a day left until the reset
  of the week   Fable may take 50% of the weekly limit and has taken 25%
```

It is forecast like the week, with one difference: only that model's usage counts, so its tokens → % conversion, its profile and its replay are learned from that model's usage alone. It has a forecast from its first read: the window began at 0% a week before its reset, and the model's usage since then is in your transcripts. The last row is what Anthropic reports about the limit itself: how much of the shared weekly limit the model may take in total, and how much it has taken.

Claude Code reports this window to `/usage` only, not to mods, so the mod reads it where `/usage` does, see [Model calls and network](#model-calls-and-network). It is as fresh as the last read: at most 5 minutes old after a response, older while you are idle.

The VS Code extension draws no plugin panes or bands, so there `/limits-forecast` prints the same report as text. It goes by whether anything of the mod has been drawn yet. `/limits-forecast text` asks for the text version anywhere.

### `/limits-forecast export`

This writes 13 CSV tables and a `summary.json` for retrospectives. The files are listed under [Your data](#your-data).

### Toasts

You get a toast when the verdict gets worse, and when a window crosses 80% and 90%: once, in the first session that sees it, not again in every session you open. The **Toasts** option in `/config` turns them off.

---

## Install

At the prompt of a Claude Code session:

```
/plugin install limits-forecast --marketplace danylo-konovalenko-brainsport/limits-forecast
```

Or from a local clone:

```
/plugin install limits-forecast --marketplace C:\path\to\limits-forecast
```

Answer `y` to add the marketplace, then choose user scope so it runs in every session.

After changing the code of a local install, run `/reload-plugins`. There's nothing to rebuild and no version to bump, because a local marketplace is read straight from the folder.

To try it without installing:

```
claude --plugin-dir ./plugins/limits-forecast
```

> **Requirements:** a Claude Code build with mod support (developed on 2.1.292, tested on 2.1.327) and a subscription plan. Only subscription plans report rate-limit windows.

---

## Model calls and network

| Question | Answer |
| --- | --- |
| Does it call Claude or any other model? | **No.** The code never touches `$.model`. |
| Does it send data anywhere? | **No.** It reads local files and writes to `~/.claude/limit-metrics/`. |
| Does it make network calls? | **One**, for the [model limits](#model-limits): a `GET` to `https://api.anthropic.com/api/oauth/usage`, the endpoint `/usage` reads, with no body. It goes out at most every 5 minutes, only after a response has come in since the last one, from one session for all of them, and not for 30 minutes after a failure. The **Model limits** option turns it off. |
| Does it see your login? | **No.** The call is signed by Claude Code: the mod gets an opaque handle from `$.session.authorize()`, and the engine attaches the credential itself, for Anthropic's own hosts only. With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set, Claude Code refuses the call. |
| Does it use your limit? | **No.** It costs nothing from the limits it watches. |
| How does it learn? | By fitting a few numbers to your history with the formulas under [The math](#the-math). |

---

## How it works

```mermaid
flowchart LR
    A[Claude Code<br/>response] -->|percent used<br/>+ reset time| R[Readings log]
    T[Transcripts<br/>~/.claude/projects] -->|tokens per message| U[Usage per 15 min<br/>in $-units]
    T -->|refused requests| H[Past limit hits]
    H -->|0% at start,<br/>100% at hit| R
    R --> C[Calibration<br/>% per unit]
    U --> C
    U --> P[Weekly profile<br/>weekday × hour]
    C --> F[Forecast<br/>+ 80% interval + risk]
    P --> F
    U --> F
    F --> V[Verdict · limits line · pane · tips]
    F -->|logged hourly| S[Self-scoring<br/>after reset]
    R --> S
```

1. **Readings.** After each response Claude Code reports every limit window (`five_hour`, `seven_day`; any other window it reports is shown too) with the percent used and the reset time. The mod logs each move of a window. A model's own weekly window (`seven_day_fable`) is read from Anthropic's usage endpoint instead and logged the same way.
2. **Usage.** Every 5 minutes (and 1 second after start) the mod reads all sessions' transcripts in `~/.claude/projects` and sums the tokens per 15-minute bucket, converted to [units](#1-units-tokens--dollars). Unchanged files come from a cache. Files over the runtime's 4 MiB read limit are streamed through `cat` (`type` on Windows), keeping only the lines the parser needs.
3. **Past hits.** When you ran out, Claude Code wrote the refused request into the transcript with `error: "rate_limit"` and `quotaLimits { rateLimitType, resetsAt }`. Each hit becomes two exact readings: 0% when the window started and 100% at the hit. So if you've ever hit a limit, calibration works from day one.
4. **Calibration** learns how many percent one unit costs, separately for each window, and checks the assumed weight of each model family you use. A model's own window is matched against that model's usage alone, and so are its profile, forecast and replay.
5. **Profile** learns when you usually work: weekday totals times an hour-of-day shape.
6. **Forecast** combines your usual pattern, today's deviation from it and the spread of your past weeks.
7. **Self-scoring** compares every logged forecast with the final percent once its window resets, and scales the conversion by how far they ran off.
8. **Self-tuning** replays past weeks to learn the settings the forecast uses: how fast bursts fade, how much recent weeks count, any bias, and how wide the range must be to hold 80%.

---

## The math

### 1. Units: tokens → dollars

Different tokens cost the limit different amounts. Tokens are weighted by Anthropic's published API list prices ([pricing](https://platform.claude.com/docs/en/about-claude/pricing), October 2026):

```math
u \;=\; P_{\text{in}}\cdot\frac{\text{in} + 1.25\,\text{cw}_{5\text{m}} + 2\,\text{cw}_{1\text{h}} + r\,\text{cache\_read} + 5\,\text{out}}{10^6}
```

| Model | $P_{\text{in}}$, $ per MTok | $r$, cache read ÷ input |
| --- | --- | --- |
| Fable 5.1, Fable 5, Mythos | 10 | 0.025 |
| Opus 5.5 | 4 | 0.05 |
| Opus 5, Opus 4.5 to 4.8 | 5 | 0.1 |
| Opus 4, Opus 4.1 | 15 | 0.1 |
| Sonnet 5, Sonnet 5.5 | 2 | 0.1 |
| Sonnet 4.x | 3 | 0.1 |
| Haiku 5.5 | 0.10 | 0.1 |
| Haiku 4.5 | 1 | 0.1 |
| anything else | 2 | 0.1 |

Output costs 5× the input everywhere. Cache writes cost 1.25× the input for the 5-minute cache and 2× for the 1-hour one; Claude Code uses the 1-hour cache, and each transcript line says which was used. Cache reads are most of a long session's tokens, so their share of the input price matters most, and it differs per model now.

One unit is about one US dollar at API list prices. It isn't what your subscription costs, and whether the limit charges Fable like the API does is what the [weight check](#3-model-weight-check-two-variable-wls--delta-method) measures.

Each message is counted once per message id, because Claude Code writes every content block of a message as its own line with the same usage. Usage is summed into 15-minute buckets (all, subagents, Opus, Fable) with a prefix-sum index, so the usage between any two moments is an O(log n) lookup. The two edge buckets are prorated. *(`price`, `units`, `usageIndex` in `model.ts`)*

### 2. Calibration: percent per unit (ratio estimator)

Anthropic doesn't publish how usage maps to percent, so the mod estimates it. Take every **stretch** between two readings of the same window. A stretch must last at least 1 h for the 5-hour window and 12 h for the weekly one. For stretch $i$:

- $y_i$ = percent points moved
- $x_i$ = units used by all local sessions in that stretch
- $`w_i = 2^{-\text{age}_i / 14\,\text{d}}`$: exponential recency weighting, half-life 14 days, looking back 28 days

The model is $`y_i = k\,x_i + \varepsilon_i`$ with $\mathrm{Var}(\varepsilon_i) \propto x_i$, since larger stretches are noisier in absolute terms. Weighted least squares through the origin under that model is the **ratio estimator** (Cochran, *Sampling Techniques*, ch. 6):

```math
\hat k \;=\; \frac{\sum_i w_i\,y_i}{\sum_i w_i\,x_i}
```

Its standard error comes from the residuals, with a small-sample correction $n/(n-1)$:

```math
s^2 = \frac{n}{n-1}\cdot\frac{\sum_i w_i\,(y_i-\hat k x_i)^2 / x_i}{\sum_i w_i},
\qquad
\mathrm{SE}(\hat k) = \sqrt{\frac{s^2 \sum_i w_i^2\,x_i}{\left(\sum_i w_i x_i\right)^2}}
```

Rules:

- $\hat k$ is used once the stretches add up to ≥ 3 percent points.
- The SE needs ≥ 3 stretches. Until then an SE of 25% of $\hat k$ is **assumed**, so that the range doesn't treat a conversion learned from a single limit hit as exact. The pane marks it as assumed.
- Stretches with points moved but no local usage are dropped. That usage came from claude.ai or another machine.

**Change detection.** A new plan, or Anthropic changing the limits, makes the old stretches wrong. Waiting for them to fade out of the 28 days would take weeks. So when the **two latest stretches both miss the fit on the same side**, each by more than

```math
\max\!\Big(30\%,\ 3\,\tfrac{\mathrm{SE}(\hat k)}{\hat k},\ \tfrac{2}{y_i}\Big)
```

the mod learns from those two alone. The last term allows for small stretches being coarse, since windows move in whole points. A single odd stretch is treated as noise. The pane says when it re-learned.

*(`calibrate`, `ratioFit`)*

### 3. Model weight check (two-variable WLS + delta method)

Is Fable really 2.5× as expensive as Opus 5.5 *against the limit*, and Opus 2× Sonnet? For each family you use (Opus, Fable), using the same stretches, the mod fits that family's usage and all other usage separately, again through the origin with weights $w_i / (x_{1i}+x_{2i})$:

```math
y_i = a\,x_{\text{family},i} + b\,x_{\text{other},i} + \varepsilon_i
```

and reports $a/b$:

- 1.0 means the assumed weight is right.
- 1.3 means the family costs 30% more of the limit than assumed.

The standard error of the ratio comes from the delta method:

```math
\mathrm{Var}\!\left(\tfrac{a}{b}\right) \approx \frac{\mathrm{Var}(a)}{b^2} + \frac{a^2\mathrm{Var}(b)}{b^4} - \frac{2a\mathrm{Cov}(a,b)}{b^3}
```

It needs ≥ 6 stretches, and both kinds of usage must vary independently, which the determinant check enforces. Otherwise the split can't be identified and the check stays silent.

Once the ratio is **clearly** different from 1, that family's usage is counted with it everywhere: the conversion, the profile and the forecast. "Clearly" means more than 2 standard errors away from 1, and measured to within 25%. *(`weightCheck`, `ratioOfTwo`, `familyWeight`, `reweight`)*

### 4. Weekly profile (multiplicative weekday × hour model)

A raw 168-cell hour-of-week table would be mostly empty. Instead the mod uses a factorized (multiplicative) seasonal model with 7 + 24 parameters:

```math
\text{expected}(d, h) \;=\; \bar U_d \cdot s_h
```

- $\bar U_d$ is the recency-weighted mean daily total for weekday $d$ (same 14-day half-life), over the last 8 weeks, complete days only, idle days counted as zero. A weekday with no history falls back to the overall mean.
- $s_h$ is the hour-of-day shape. It is recency-weighted, smoothed with a $[\tfrac14,\tfrac12,\tfrac14]$ kernel over neighbouring hours, and normalized so that $\sum_h s_h = 1$.

*(`profile`, `expectedUnits`)*

### 5. Point forecast (profile + mean-reverting deviation)

Let $H$ be the hours to reset, $p$ the percent used now, and $L$ the look-back: 1 h for the 5-hour window, 24 h for the week.

- Usual usage until reset: $`U_{\text{usual}} = \int_{\text{now}}^{\text{reset}} \text{expected}(t)\,dt`$
- Today's deviation: $\Delta = \dfrac{U_{\text{last }L}}{L} - \dfrac{U^{\text{expected}}_{\text{last }L}}{L}$ (units per hour)

A burst doesn't last until the reset, and a slow morning doesn't either. So the deviation decays exponentially (mean reversion) with time constant $\tau$: 1 h for the 5-hour window, 12 h for the week. Integrated over the time left:

```math
B = \max\!\Big(0,\; U_{\text{usual}} + \Delta\,\tau\,\big(1-e^{-H/\tau}\big)\Big),
\qquad
\hat P = p + \hat k\,B
```

$\hat k$ here is the learned conversion times the [scored correction](#10-scored-correction). The model forecast needs $\hat k$, at least 3 days of history and a known reset time. Until then the forecast is the baseline below. *(`forecast`)*

### 6. Baseline: "the current speed holds"

```math
\text{rate} = \frac{\hat k\,U_{\text{last }L}}{L},
\qquad
P_{\text{baseline}} = p + \text{rate}\cdot H
```

Before $\hat k$ is known, the rate is the ordinary least-squares slope of the readings themselves. That needs ≥ 3 readings spanning ≥ $L/4$. The baseline does two jobs:

- It's the naive benchmark the skill score compares against.
- It feeds the "you hit the limit in ~40 m" warning.

*(`readingRate`, `slope`)*

### 7. 80% prediction interval and risk (kernel density estimate)

How much could the rest of this window differ from the forecast? The mod looks at how the same stretch went in the past:

- Weekly window: the same stretch (now → reset) in each of up to 9 previous weeks.
- 5-hour window: the same clock stretch on up to 14 previous days of the same kind (workday or weekend), looking back 28 days.

From the past usages $u_j$ with mean $\bar u$, build one scenario per past stretch, with the same forecast and that stretch's deviation from normal:

```math
S_j = p + \hat k\cdot\max\!\big(0,\; B + u_j - \bar u\big)
```

The scenarios are smoothed into one distribution, a **Gaussian kernel density estimate**. Each scenario gets a kernel whose width $\sigma$ combines **Silverman's rule-of-thumb bandwidth** $h$ with the uncertainty of $\hat k$ (the two error sources treated as independent):

```math
F(x) = \frac1n\sum_j \Phi\!\left(\frac{x - S_j}{\sigma}\right),
\qquad
\sigma = \sqrt{h^2 + \big(\mathrm{SE}(\hat k)\,B\big)^2},
\qquad
h = 0.9\,\min\!\big(s,\ \tfrac{\text{IQR}}{1.34}\big)\,n^{-1/5}
```

$\Phi$ is the standard normal CDF. The **80% prediction interval** and the **risk** are both read from $F$, so they always agree:

```math
\text{lo} = \max\big(p,\ F^{-1}(0.1)\big),
\qquad
\text{hi} = F^{-1}(0.9),
\qquad
\text{risk} = 1 - F(100)
```

$F^{-1}$ is found by bisection. The interval is clipped below at $p$ because usage never goes back. Smoothing matters with few past stretches: the 10% and 90% sample quantiles of 4 weeks always lie inside the observed weeks, which makes a raw interval too narrow, and a count-based risk could only move in steps of 1/n. If the scenarios don't vary at all, the plain sample quantiles (type 7, Hyndman & Fan 1996) and the plain share at or above 100% are used.

The interval and risk need ≥ 3 past stretches, and the pane says how many it compared with. Regular habits and more history give a narrower range; irregular use gives a wider one.

### 8. Regularity

The coefficient of variation of your complete past weeks (up to 8):

```math
\text{CV} = \frac{s}{\bar x}
```

"Your weeks vary ±48%" means CV = 0.48. *(`regularity`, `cv`)*

### 9. Self-tuning by replaying the past

Several settings above are reasonable guesses: how fast a deviation fades ($\tau$), the profile's half-life, the width of the range. Once an hour the mod checks them against your own history with a **rolling-origin backtest** (time-series cross-validation; Hyndman & Athanasopoulos, §5.10):

1. **Replay.** At past moments (every 2 h for the 5-hour window, every 6 h for the week) it forecasts the usage until the current horizon, using only what was known at that moment, and compares with what happened. This is done in usage units, so no past limit readings are needed.
2. **Point forecast.** It tries $`\tau \in \{15\text{ m}, 1, 2, 4\text{ h}\}`$ (5-hour) or $`\{3, 12, 24, 48\text{ h}\}`$ (week), and profile half-lives of $`\{7, 14, 28\}`$ days. It keeps the pair with the smallest mean absolute error, but **only if it beats the defaults by at least 5%**. A smaller gain over a few weeks is easily noise.
3. **Bias.** With those settings, forecasts are multiplied by $\sum \text{actual} / \sum \text{forecast}$ (a ratio estimator again), clipped to $[0.67, 1.5]$, and ignored when within 5% of 1.
4. **Range width.** The deviations of the past stretches are scaled by a factor $`c \in \{0.5, \dots, 4\}`$ until the replayed 80% ranges held closest to 80% of the outcomes. This is **calibrating the prediction interval** on held-out data, the idea behind conformal prediction. Ties go to the factor nearest 1. Scaling the deviations also scales the kernel bandwidth, so the range and the risk stay one distribution.

Replayed moments a few hours apart share most of their future, so they are not independent. The mod counts them as $`\min\big(n,\ \lfloor \text{span} / \text{horizon} \rfloor + 1\big)`$ and **uses tuned settings only from 10 independent cases**. Before that it uses the defaults:
- For the 5-hour window that's after a few days.
- For the week it takes about 6–7 weeks of history: 3 weeks to compare with, plus the replay span.

The pane's "fit" rows show what was learned, for example "range ×2.5 so it held 80% instead of 59%". *(`tune`, `expectedBase`, `scenarios`)*

### 10. Scored correction

The replay above works in usage units, so it cannot see an error in $\hat k$ itself. Usage on claude.ai or another machine moves the windows more than your local usage explains, which makes $\hat k$ too high and every forecast run high; and the weekly replay takes 6–7 weeks before it tunes anything. The [scored forecasts](#how-it-scores-itself) can see it. Over the last 28 days, with each forecast's increase taken before any correction it already carried and both sides capped at the room the window had:

```math
c = \frac{\sum_i (y_i - p_i)}{\sum_i (\hat P_i - p_i)}
```

Once 5 forecasts over 3 windows are scored, $\hat k$ is multiplied by $c$, clipped to $[0.5, 1.5]$ and ignored within 5% of 1. Every logged forecast records the $c$ it was made with, so the next estimate measures the model and not its own correction. The pane's quality row shows it as "forecasts now scaled ×0.80". *(`correction`, `evaluate`)*

### Verdicts

| Verdict | When |
| --- | --- |
| **HOLD ON** | ≥ 95% used, or the current speed reaches 100% before the reset *and* within 45 min (5-hour) / 6 h (week). |
| **SLOW DOWN** | risk above 55%, and then until the risk is under 45% again (or, before risk exists, point forecast > 100%), or ≥ 85% used. |
| **OK** | Otherwise. |

Only hard data (the limit itself, or the measured speed) can say HOLD ON. A forecast from your usual pattern can only say SLOW DOWN. The 45–55% band keeps the verdict from flapping around one number, and each window's last verdict is shared by all sessions, so a new session starts from the same one.

### Suggestions

Shown when a window is tight: not OK, or a forecast ≥ 100%, or a risk ≥ 50%. Each one is triggered by a measurement:

| Tip | Trigger |
| --- | --- |
| `/compact` or `/clear` | main context > 120k tokens (every message re-sends it) |
| Switch model | Fable or Opus > 60% of the last 5 h of usage. The tip names the cheaper models and how much longer the limit lasts at list prices: from Fable, Opus 5.5 about 2.5× and Sonnet 5.5 about 5×; from Opus 5.5, Sonnet 5.5 about 2×. When a model's own weekly window is the tight one, the tip says so instead: other models don't count against it |
| Fewer subagents | subagents > 40% of the last 5 h |
| Take a break | only the 5-hour window is in trouble: a break until its reset costs nothing from the week |
| Daily budget | the weekly window is in trouble: $(100 - p) / \text{days left}$ per day |
| Room for big tasks | nothing tight, > 10 points under an even pace this week, forecast < 90% and risk < 25% |

The export records whether each tip was followed within the hour, for example a switch to a cheaper model or the context shrinking after `/compact`.

---

## How it scores itself

Once an hour, each window's forecast is logged. One forecast per window per hour counts, even across sessions. After the window resets, each forecast is compared with the final percent $y$, the window's last reading, over the last 28 days.

| Metric | Formula | Good means |
| --- | --- | --- |
| **MAE**: mean absolute error | $\frac1n\sum \lvert \hat P - y\rvert$ | small |
| **Bias**: mean error | $\frac1n\sum (\hat P - y)$ | ≈ 0 (positive means the forecasts ran high) |
| **Coverage** of the 80% interval | share with $\text{lo} - 0.5 \le y \le \text{hi} + 0.5$ | ≈ 80%: far less means overconfident, far more means too cautious |
| **Sharpness**: mean interval width | $\frac1n\sum(\text{hi}-\text{lo})$ | as narrow as coverage allows |
| **Brier score** of the risk (Brier, 1950) | $\frac1n\sum(\text{risk} - \mathbb 1[y \ge 100])^2$ | 0 is perfect, 0.25 is a coin toss |
| **Skill** vs. the baseline | $1 - \dfrac{\text{MAE}_{\text{model}}}{\text{MAE}_{\text{baseline}}}$ | > 0 beats "the current speed holds" |

Notes:

- Forecasts and outcomes are capped at 100% before scoring, since the reported percent can overshoot.
- The ±0.5 tolerance on coverage allows for windows moving in whole points.
- A forecast made after a window's last reading counts too: the window went idle, so that reading is its outcome. Leaving those out would hide exactly the forecasts that overshot.
- The scored increases feed the [correction](#10-scored-correction).

The pane shows these in plain words, with how many windows they come from, and `forecasts.csv` has every scored forecast for your own analysis.

---

## Your data

Everything stays in `~/.claude/limit-metrics/` (or `$CLAUDE_CONFIG_DIR/limit-metrics/`).

| File | Contents |
| --- | --- |
| `log-YYYY-MM-<session>.jsonl` | Readings, turns (tokens, context size, duration, interrupted or not), forecasts (with the correction they carried) and events (warnings shown or hidden, tips, pane opened). One file per session and month. Written every 5 minutes and at session end. |
| `rollup-YYYY-MM.json` | Each transcript's usage per day: tokens per model, tool calls, active quarter-hours, project, effort level, attribution (skill, plugin, MCP server, subagent type), turn and thinking time, interrupted answers, compactions and limit hits. Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default); the rollups keep your history. |
| `history-cache.json` | Usage per 15 minutes and limit hits per transcript, keyed by size and modification time. Kept for 10 weeks, also after Claude Code deletes the transcript, so the forecast can compare with up to 9 past weeks. A change of the token weights bumps its version and the transcripts are read again once. |

The warning state every session shares (the current warning, the hidden one, each window's last verdict, the 80% and 90% marks already toasted) and the last answer about the model limits are in the mod's store, which Claude Code keeps under its configuration directory.

### Export (`/limits-forecast export` → `export/`)

| File | Contents |
| --- | --- |
| `usage-daily.csv` | date, project, model, tokens by type, API-equivalent $ |
| `tools-daily.csv` | tool calls per day and project |
| `active-daily.csv` | active hours, turn hours, thinking hours, interrupted answers |
| `effort-daily.csv` | usage per effort level |
| `attribution-daily.csv` | usage per skill, plugin, MCP server and subagent type |
| `compactions.csv` | manual or auto, tokens before and after |
| `limits.csv` | every reading |
| `limit-hits.csv` | every limit hit, including from before the mod was installed, with hours blocked and retries |
| `forecasts.csv` | every forecast with its outcome |
| `turns.csv` | every turn logged live |
| `events.csv` | warnings, hides, pane opens |
| `tips.csv` | each tip shown and whether it was followed |
| `summary.json` | totals, per project, per effort, per attribution, limit hits, compactions, time, forecast quality, warnings |

**Privacy:** only numbers and model, tool and project names are stored. Prompts, answers and code are never stored.

---

## Limitations

- **Plans:** the limit readings exist on subscription plans only, and the first one arrives with the first response of a session.
- **Conversion:** Anthropic doesn't publish the usage → percent formula. The conversion is learned and approximate, and windows move in whole points, so the first stretches are coarse.
- **Other usage:** limit hits and stretches assume the usage came from Claude Code on this machine. claude.ai or another computer in the same window makes the limit look smaller. Stretches with *no* local usage are dropped.
- **History needed:** the interval and risk need a few past weeks (days for the 5-hour window).
- **Model limits:** the usage endpoint is not a documented API. The mod reads the shape Claude Code 2.1.327 reads; if Anthropic changes it, the model's window disappears from the line and the pane and the rest works as before. Only Fable and Opus usage is tracked per model, so another model's own window is shown and forecast from its readings alone. Its first read comes mid-window, so the conversion is first learned from one long stretch (0% when the window began, a week before its reset, to the percent read) with an assumed ±25% until three stretches are in; usage of that model elsewhere in that stretch makes the limit look smaller.
- **Other windows:** a window kind beyond these (a gateway's spend limit aside) is shown and forecast like the 5-hour one, labelled by its kind, until the mod knows it better.
- **File size:**
  - Transcripts over 4 MiB are streamed through `cat`/`type`. The pane shows how many couldn't be read.
  - A monthly rollup over 4 MiB stops updating.
- **Timezone:** the weekday profile uses the mod runtime's timezone.
- **Old logs:** they aren't deleted automatically, because mods can't delete files. They're small, so delete old months by hand if you like.

---

## Development

```
claude plugin validate plugins/limits-forecast
claude plugin test plugins/limits-forecast
```

```
plugins/limits-forecast/
├── hooks/
│   ├── stats.ts       # mean, type-7 quantile, CV, OLS slope, ratio estimator, 2-variable WLS
│   ├── model.ts       # prices, units, buckets, transcript parser, calibration, weight check, profile, forecast, verdict, scoring, correction, limits line
│   ├── retro.ts       # logs, daily rollups, limit hits, CSV/JSON export
│   ├── report.ts      # the pane's rows and the text report
│   └── register.tsx   # wiring: Claude Code events, options, shared warning state, the model limits read, limits line and warning above the prompt, pane, /limits-forecast command
├── tests/             # model, retro, report, register and end-to-end flow tests
└── types/index.d.ts   # the mod's state contract
```

The logic lives in pure functions with no I/O, tested in `tests/`. `register.tsx` is the only file that talks to Claude Code.

---

## References

- W. G. Cochran, *Sampling Techniques*, 3rd ed., Wiley, 1977, ch. 6: ratio estimators.
- R. J. Hyndman, G. Athanasopoulos, *Forecasting: Principles and Practice*, 3rd ed., [otexts.com/fpp3](https://otexts.com/fpp3/): prediction intervals, bootstrapped residuals, benchmark methods, forecast accuracy.
- R. J. Hyndman, Y. Fan, "Sample Quantiles in Statistical Packages", *The American Statistician* 50(4), 1996: quantile type 7.
- B. W. Silverman, *Density Estimation for Statistics and Data Analysis*, Chapman & Hall, 1986, §3.4: the rule-of-thumb bandwidth.
- M. Abramowitz, I. A. Stegun, *Handbook of Mathematical Functions*, 1964, 7.1.26: the normal CDF approximation.
- G. W. Brier, "Verification of Forecasts Expressed in Terms of Probability", *Monthly Weather Review* 78(1), 1950.
- T. Gneiting, A. E. Raftery, "Strictly Proper Scoring Rules, Prediction, and Estimation", *JASA* 102(477), 2007: calibration and sharpness.
- G. Casella, R. L. Berger, *Statistical Inference*, 2nd ed., 2002, §5.5.4: the delta method.
- Anthropic, [API pricing](https://platform.claude.com/docs/en/about-claude/pricing): the relative weights of models and token types.
