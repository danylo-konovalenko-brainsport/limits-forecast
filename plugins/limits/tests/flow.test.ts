import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const CFG = '/cfg'

// One past session in the transcripts, for the backfill.
const transcript = Array.from({ length: 20 }, (_, i) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(NOW - (i + 1) * 3_600_000).toISOString(),
    message: { id: `m${i}`, model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 5000, cache_read_input_tokens: 50000, output_tokens: 800 } },
  }),
).join('\n')

test('a limit reading produces a forecast, a status line and a log', async ($, on) => {
  const files: Record<string, string> = { [`${CFG}/projects/p1/s.jsonl`]: transcript }
  const statuses: (string | undefined)[] = []
  const v = (value: unknown) => ({ value }) as never
  const limits = [
    { kind: 'five_hour', percentUsed: 92, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
    { kind: 'seven_day', percentUsed: 30, resetsAt: new Date(NOW + 4 * 86_400_000).toISOString() },
  ]

  on('env.get', async (_$, e) => v((e as { name: string }).name === 'CLAUDE_CONFIG_DIR' ? CFG : undefined))
  let tick = 0
  on('clock.now', async () => v(NOW + (tick += 1000)))
  on('clock.every', async () => v(undefined))
  on('clock.after', async () => v(undefined))
  on('session.id', async () => v('abcdef12-0000'))
  on('store.get', async () => v(undefined))
  const stored: Record<string, unknown> = {}
  on('store.set', async (_$, e) => {
    const x = e as { key: string; value: unknown }
    stored[x.key] = x.value
    return v(undefined)
  })
  on('turn.complete', async () => ({ text: '' }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (e as { path: string }).path
    const names = new Map<string, 'file' | 'dir'>()
    for (const f of Object.keys(files)) {
      if (!f.startsWith(dir + '/')) continue
      const rest = f.slice(dir.length + 1).split('/')
      names.set(rest[0] ?? '', rest.length > 1 ? 'dir' : 'file')
    }
    return v([...names].map(([name, kind]) => ({ name, kind, size: files[`${dir}/${name}`]?.length ?? 0, mtimeMs: NOW, isLink: false })))
  })
  on('fs.read', async (_$, e) => {
    const p = (e as { path: string }).path
    if (files[p] === undefined) throw new Error('ENOENT')
    return v(files[p])
  })
  on('fs.write', async (_$, e) => {
    const x = e as { path: string; text: string }
    files[x.path] = x.text
    return v(undefined)
  })
  on('command.register', async () => v(undefined))
  on('ui.toast', async () => v(undefined))
  on('ui.render', async ($$, e) => {
    const { Box } = $$.ui.resolve(e as never) as any
    return (globalThis as any).h(Box, null) as never
  })
  on('ui.status', async (_$, e) => {
    statuses.push((e as { text?: string }).text)
    return v(undefined)
  })
  on('session.usage', async () => v({ startedAt: 0, context: { tokens: 150_000, window: 200_000 }, rateLimits: limits }))
  on('session.start', async (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.measure', async (_$, e) => ({ changed: (e as { changed: string[] }).changed }) as never)
  on('session.end', async (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: 150_000, window: 200_000 }, rateLimits: limits, changed: ['rateLimits'] } as never)

  // The backfill runs on a timer after start; give it a moment.
  await new Promise(r => setTimeout(r, 300))
  const cache = files[`${CFG}/limit-metrics/history-cache.json`] ?? ''
  expect(cache).toContain('/cfg/projects/p1/s.jsonl')

  const last = statuses.filter(Boolean).pop() ?? ''
  expect(last).toContain('5h 92%')
  expect(last).toContain('slow down')
  expect(last).toContain('wk 30%')

  // Learning: usage between two readings is matched to the points moved.
  await $.turn.complete({
    reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1',
    usage: { model: 'claude-opus-5-5', input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 400_000 },
  } as never)
  limits[0]!.percentUsed = 95
  await $.session.measure({
    context: { tokens: 150_000, window: 200_000 },
    rateLimits: [limits[0]!],
    changed: ['rateLimits'],
  } as never)
  expect(stored.calib).toEqual({ five_hour: { dp: 3, du: 10 } })

  // The pane and the warning band draw on both surfaces; Hide dismisses the band.
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'limits', surface, component: 'Pane', requestId: 'limits', props: {} } as never)
    expect((await pane.find({ type: 'Text', text: /5-hour/ } as never))?.text).toContain('5-hour 95%')
    await pane.unmount()
  }
  const band = await $.ui.mount({ plugin: 'limits', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20 } } as never)
  expect((await band.find({ type: 'Text', text: /Hold on/ } as never))?.text).toContain('Hold on: 5-hour limit almost used')
  await band.press({ key: 'hide' } as never)
  expect(await band.find({ type: 'Text', text: /Hold on/ } as never)).toBeFalsy()
  await band.unmount()

  await $.session.end({ reason: 'other', sessionId: 'abcdef12-0000' } as never)
  const log = files[`${CFG}/limit-metrics/log-2026-10-abcdef12.jsonl`] ?? ''
  expect(log).toContain('"k":"r"')
  expect(log).toContain('"w":"five_hour"')
})
