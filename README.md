# claude-limits-mod

Claude Code mods for keeping an eye on your usage limits.

**limits** watches your 5-hour and weekly limits. It tells you whether you will run out before the reset if you keep your current speed, learns how you usually use Claude, and suggests what to change when you're burning too fast.

**token-speed** shows how fast the model generates (tokens per second, time to first token).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install limits --marketplace C:\projects\git\claude-limits-mod
```

Answer `y` to add the marketplace, then pick a scope (user scope = every session). `token-speed` installs the same way. Once the repo is on GitHub, `--marketplace <owner>/<repo>` works too.

To try a change without installing: `claude --plugin-dir C:\projects\git\claude-limits-mod\plugins\limits`.

## What you see

- **Status line:** `Limits 5h 62% → slow down · wk 41%`. Only windows under pressure get a verdict.
- **Warning band above the prompt:** appears only when a forecast says you will run out before the reset, with the top suggestions. `Hide` keeps it away until the situation changes; `Details` opens the pane.
- **`/limits` pane:** per window: usage, reset time, current speed, even pace, the projection at the current speed and from your usual pattern, the per-day budget for the week, suggestions, and your history (busiest days, estimated past weeks).
- **Toasts:** when the verdict gets worse, and at 80% and 90%.

Verdicts: **OK**, **slow down** (at this speed you hit the limit before the reset, your usual pattern would, or you are past 85%), **hold on** (≥95%, or the limit is less than 45 minutes away for the 5-hour window, or a day away for the week).

## How it works

Claude Code reports the limit windows (`five_hour`, `seven_day`) with the percent used and the reset time after each response. The mod:

1. **Logs** every change of a window and the token usage of every turn.
2. **Reads your past sessions** from Claude Code's transcripts (`~/.claude/projects`) and sums the usage per hour. The result is cached, so later starts only read new or changed transcripts.
3. **Learns the conversion** from tokens to percent: whenever a window moves, the points it moved are matched to the usage in between. Tokens are weighted like API prices (output costs more than input, cache reads little, Opus more than Sonnet). After about 3 points of live use the conversion is ready, and from then on your whole history counts as percent. That is where "your usual pattern" and "past weeks (estimated)" come from.
4. **Forecasts:** the 5-hour window is judged on the last hour, the week on the last 24 hours (nobody works 24/7), plus your average usage for each hour of the week over the last 4 weeks.

## Data

Everything stays on your machine, in `~/.claude/limit-metrics/` (or `$CLAUDE_CONFIG_DIR/limit-metrics/`):

- `log-YYYY-MM-<session>.jsonl`: one line per reading or turn. One file per session and month, so parallel sessions never overwrite each other. Written every 5 minutes and when the session ends.
- `history-cache.json`: hourly usage per transcript.
- The learned conversion is kept in the mod's own store.

Only numbers are stored, never prompts or code.

## Limitations

- The limit readings exist on subscription plans only, and the first one arrives with the first response of a session.
- Anthropic doesn't publish how usage maps to percent. The conversion is learned and approximate, and usage from other apps (claude.ai, other machines) shows up as jumps the mod can't explain.
- Transcripts over 4 MiB can't be read by a mod and are skipped; the pane shows how many.
- Old log files are not deleted automatically (mods can't delete files); they are small, delete the folder's old months by hand if you like.

## Development

```
claude plugin validate plugins/limits
claude plugin test plugins/limits
```

`hooks/model.ts` holds all the logic as plain functions (tested in `tests/model.test.ts`); `hooks/register.tsx` wires it to Claude Code's events and UI.
