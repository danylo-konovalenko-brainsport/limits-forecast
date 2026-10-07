import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const CFG = '/cfg'
// The engine may hand hooks native paths (C:\cfg\...); key the mock fs by POSIX form.
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// One past session in the transcripts, for the backfill.
const transcript = Array.from({ length: 20 }, (_, i) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(NOW - (i + 1) * 3_600_000).toISOString(),
    message: { id: `m${i}`, model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 5000, cache_read_input_tokens: 50000, output_tokens: 800 } },
  }),
).join('\n')

// A long session past the 4 MiB read limit, with a refused request in it.
const BIG = `${CFG}/projects/p2/big.jsonl`
const big = [
  JSON.stringify({
    type: 'assistant', timestamp: new Date(NOW - 3 * 3_600_000).toISOString(), cwd: '/work/bigproj',
    message: { id: 'b1', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 } },
  }),
  JSON.stringify({ type: 'user', message: { content: 'x'.repeat(50) } }),
  JSON.stringify({
    type: 'assistant', timestamp: new Date(NOW - 2 * 3_600_000).toISOString(), error: 'rate_limit',
    quotaLimits: { status: 'rejected', resetsAt: (NOW - 3_600_000) / 1000, rateLimitType: 'five_hour' },
    message: { model: '<synthetic>', content: [], usage: { input_tokens: 0, output_tokens: 0 } },
  }),
].join('\n')

test('a limit reading produces a forecast, a status line and a log', async ($, on) => {
  const files: Record<string, string> = { [`${CFG}/projects/p1/s.jsonl`]: transcript, [BIG]: big }
  const statuses: (string | undefined)[] = []
  const v = (value: unknown) => ({ value }) as never
  const limits = [
    { kind: 'five_hour', percentUsed: 92, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
    { kind: 'seven_day', percentUsed: 30, resetsAt: new Date(NOW + 4 * 86_400_000).toISOString() },
  ]

  on('env.get', async (_$, e) => v((e as { name: string }).name === 'CLAUDE_CONFIG_DIR' ? CFG : undefined))
  const clock = mock.clock(on, { now: NOW })
  on('session.id', async () => v('abcdef12-0000'))
  on('turn.complete', async () => ({ text: '' }) as never)
  on('fs.list', async (_$, e) => {
    const dir = norm((e as { path: string }).path)
    const names = new Map<string, 'file' | 'dir'>()
    for (const f of Object.keys(files)) {
      if (!f.startsWith(dir + '/')) continue
      const rest = f.slice(dir.length + 1).split('/')
      names.set(rest[0] ?? '', rest.length > 1 ? 'dir' : 'file')
    }
    const size = (path: string) => (path === BIG ? 5 * 1024 * 1024 : files[path]?.length ?? 0)
    return v([...names].map(([name, kind]) => ({ name, kind, size: size(`${dir}/${name}`), mtimeMs: NOW, isLink: false })))
  })
  // Over 4 MiB the mod streams the file through cat; the test hands it out in two pieces.
  on('process.spawn', async function* (_$, e) {
    const argv = (e as { argv: string[] }).argv
    expect(argv[0]).toBe('cat')
    const text = files[norm(argv[1] ?? '')] ?? ''
    yield { stream: 'stdout', text: text.slice(0, 100) } as never
    yield { stream: 'stdout', text: text.slice(100) } as never
    return v({ code: 0, signal: null })
  })
  on('fs.read', async (_$, e) => {
    const p = norm((e as { path: string }).path)
    if (p === BIG) throw new Error('over 4 MiB')
    if (files[p] === undefined) throw new Error('ENOENT')
    return v(files[p])
  })
  on('fs.exists', async (_$, e) => v(files[norm((e as { path: string }).path)] !== undefined))
  on('fs.write', async (_$, e) => {
    const x = e as { path: string; text: string }
    files[norm(x.path)] = x.text
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

  // The backfill runs on a timer a second after start.
  await clock.advance(1000)
  const cache = files[`${CFG}/limit-metrics/history-cache.json`] ?? ''
  expect(cache).toContain('/cfg/projects/p1/s.jsonl')
  expect(cache).toContain('/cfg/projects/p2/big.jsonl')
  // The transcript's days are kept in the monthly rollup, which outlives it.
  expect(files[`${CFG}/limit-metrics/rollup-2026-10.json`] ?? '').toContain('"project":"p1"')

  // The limits line is drawn in the band, not the plain status line.
  expect(statuses.filter(Boolean)).toEqual([])
  const lineBand = await $.ui.mount({ plugin: 'limits-forecast', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 300 } } as never)
  const text = async (re: RegExp) => (await lineBand.find({ type: 'Text', text: re } as never))?.text
  expect(await text(/^   · \d\d:\d\d$/)).toBeTruthy()
  expect(await text(/^92%$/)).toBe('92%')
  expect(await text(/^30%$/)).toBe('30%')
  // Wide enough: each window has its small bar with the limit mark.
  expect(await text(/^│$/)).toBe('│')
  expect(await text(/^3h00$/)).toBe('3h00')
  // The refused request in the large transcript taught tokens → %: the 5-hour
  // window has a forecast, and at the test's speed it runs out within the hour.
  expect(await text(/^\d+%$/)).toBeTruthy()
  expect(await lineBand.find({ type: 'Text', text: /^\d+%$/, color: 'error' } as never)).toBeTruthy()
  expect(await text(/^HOLD ON$/)).toBe('HOLD ON')

  // A response that does not move a window still refreshes the time.
  await clock.advance(3 * 60_000)
  await $.session.measure({ context: { tokens: 150_000, window: 200_000 }, rateLimits: limits, changed: ['context'] } as never)
  const at = new Date(clock.now())
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  expect(await text(/^   · /)).toBe(`   · ${hm}`)
  await lineBand.unmount()

  // A turn is logged with its duration; the window moves on.
  await clock.advance(1000)
  await $.turn.complete({
    reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1',
    usage: { model: 'claude-opus-5-5', input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 400_000 },
  } as never)
  limits[0]!.percentUsed = 95
  await clock.advance(1000)
  await $.session.measure({
    context: { tokens: 150_000, window: 200_000 },
    rateLimits: [limits[0]!],
    changed: ['rateLimits'],
  } as never)

  // The pane and the warning band draw on both surfaces; Hide dismisses the band.
  const hitsPane = await $.ui.mount({ plugin: 'limits-forecast', surface: 'terminal', component: 'Pane', requestId: 'limits', props: {} } as never)
  expect((await hitsPane.find({ type: 'Text', text: /× 5-hour/ } as never))?.text).toContain('1× 5-hour · 1.0 h blocked')
  await hitsPane.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'limits-forecast', surface, component: 'Pane', requestId: 'limits', props: {} } as never)
    expect((await pane.find({ type: 'Text', text: /% now/ } as never))?.text).toBe('95% now')
    await pane.unmount()
  }
  const band = await $.ui.mount({ plugin: 'limits-forecast', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20 } } as never)
  expect((await band.find({ type: 'Text', text: /Hold on/ } as never))?.text).toContain('Hold on: 5-hour limit almost used')
  await band.press({ key: 'hide' } as never)
  expect(await band.find({ type: 'Text', text: /Hold on/ } as never)).toBeFalsy()
  // Hidden, the warning goes; the limits line stays.
  expect(await band.find({ type: 'Text', text: /^HOLD ON$/ } as never)).toBeTruthy()
  await band.unmount()

  // As text, for surfaces without panes: the same rows.
  const report = (await $.command.run({ command: 'limits-forecast', args: 'text' } as never)).text ?? ''
  expect(report).toContain('95% now')
  expect(report).toContain('1× 5-hour · 1.0 h blocked')
  expect(report).toContain('Suggestions')

  // The export writes the tables and the summary.
  const exported = await $.command.run({ command: 'limits-forecast', args: 'export' } as never)
  expect(exported.text).toContain(`${CFG}/limit-metrics/export`)
  const summary = JSON.parse(files[`${CFG}/limit-metrics/export/summary.json`] ?? '{}')
  expect(summary.byProject.p1.turns).toBe(20)
  expect(summary.byProject.bigproj.turns).toBe(1)
  expect(summary.limitHits.five_hour.count).toBe(1)
  expect(summary.warnings.shown).toBeGreaterThan(0)
  expect(summary.warnings.hidden).toBe(1)

  // Claude Code deletes old transcripts; their usage and hits stay in the cache.
  delete files[BIG]
  delete files[`${CFG}/projects/p1/s.jsonl`]
  await clock.advance(5 * 60_000)
  const kept = files[`${CFG}/limit-metrics/history-cache.json`] ?? ''
  expect(kept).toContain('/cfg/projects/p1/s.jsonl')
  expect(kept).toContain('"kind":"five_hour"')
  const pane = await $.ui.mount({ plugin: 'limits-forecast', surface: 'terminal', component: 'Pane', requestId: 'limits', props: {} } as never)
  expect((await pane.find({ type: 'Text', text: /× 5-hour/ } as never))?.text).toContain('1× 5-hour')
  await pane.unmount()

  await $.session.end({ reason: 'other', sessionId: 'abcdef12-0000' } as never)
  const log = files[`${CFG}/limit-metrics/log-2026-10-abcdef12.jsonl`] ?? ''
  expect(log).toContain('"k":"r"')
  expect(log).toContain('"w":"five_hour"')
  expect(log).toContain('"d":1000')
  expect(log).toContain('"e":"hide"')
})
