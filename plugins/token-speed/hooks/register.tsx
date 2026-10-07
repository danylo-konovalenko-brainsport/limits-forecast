import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Step } from '../types'

const PANE = 'token-speed'
const steps = atom({ plugin: 'token-speed', key: 'steps' } as const, [])

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`)
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const bar = (value: number, max: number, width = 20) => {
  const n = max > 0 ? Math.max(0, Math.min(width, Math.round((value / max) * width))) : 0
  return '█'.repeat(n) + '·'.repeat(width - n)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'token-speed',
      description: 'Show token speed analytics (tokens/second, latency, cache) in a pane',
    })
    return next(e)
  })

  on('command.run', { command: 'token-speed' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Token speed' })
    return { text: 'Token speed pane opened.' }
  })

  // Time every model response: first-token latency, then generation speed.
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    let firstAt = 0
    for await (const chunk of next(e)) {
      if (firstAt === 0 && chunk.kind !== 'engine') firstAt = await $.clock.now()
      if (chunk.kind === 'stop' && chunk.usage) {
        const endedAt = await $.clock.now()
        const first = firstAt || endedAt
        const genMs = Math.max(1, endedAt - first)
        const u = chunk.usage
        const step: Step = {
          at: endedAt,
          model: u.model,
          outputTokens: u.output_tokens,
          inputTokens: u.input_tokens,
          cacheRead: u.cache_read_input_tokens,
          cacheWrite: u.cache_creation_input_tokens,
          ttftMs: first - startedAt,
          genMs,
          tps: (u.output_tokens / genMs) * 1000,
        }
        await update($, steps, list => [...list, step].slice(-200))
        if (step.outputTokens >= 20) {
          $.ui.status(`⚡ ${step.tps.toFixed(0)} tok/s · ${sec(step.ttftMs)} to first token`)
        }
      }
      yield chunk
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, steps)

    if (list.length === 0) {
      return <Text dimColor>No model responses measured yet.</Text>
    }

    // Short responses are dominated by latency; judge speed on 20+ tokens.
    const real = list.filter(s => s.outputTokens >= 20)
    const out = list.reduce((a, s) => a + s.outputTokens, 0)
    const inp = list.reduce((a, s) => a + s.inputTokens, 0)
    const cr = list.reduce((a, s) => a + s.cacheRead, 0)
    const cw = list.reduce((a, s) => a + s.cacheWrite, 0)
    const genMs = real.reduce((a, s) => a + s.genMs, 0)
    const avg = genMs > 0 ? (real.reduce((a, s) => a + s.outputTokens, 0) / genMs) * 1000 : 0
    const sorted = real.map(s => s.tps).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0
    const peak = sorted[sorted.length - 1] ?? 0
    const ttft = list.reduce((a, s) => a + s.ttftMs, 0) / list.length
    const hit = cr + cw + inp > 0 ? (cr / (cr + cw + inp)) * 100 : 0
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 12)
    const recent = list.slice(-room)
    const max = Math.max(1, ...recent.map(s => s.tps))

    return (
      <Box flexDirection="column">
        <Text bold>Speed (responses with 20+ output tokens: {real.length})</Text>
        <Text>avg {avg.toFixed(0)} tok/s · median {median.toFixed(0)} · peak {peak.toFixed(0)}</Text>
        <Text>first token avg {sec(ttft)}</Text>
        <Text> </Text>
        <Text bold>Tokens this session ({list.length} responses)</Text>
        <Text>out {fmt(out)} · in {fmt(inp)} · cache read {fmt(cr)} · cache write {fmt(cw)}</Text>
        <Text>cache hit rate {hit.toFixed(0)}%</Text>
        <Text> </Text>
        <Text bold>Recent responses (tok/s)</Text>
        {recent.map(s => (
          <Text dimColor={s.outputTokens < 20}>
            {bar(s.tps, max)} {s.tps.toFixed(0).padStart(4)} · {fmt(s.outputTokens)} tok · {sec(s.ttftMs)}
          </Text>
        ))}
      </Box>
    )
  })
}
