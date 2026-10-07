import { expect, mock, test } from 'claude-code/testing'

test('/limits opens the pane', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  let opened = ''
  on('ui.open', async (_$, e) => {
    opened = (e as { id: string }).id
    return { value: undefined } as never
  })
  const r = await $.command.run({ command: 'limits', args: '' } as never)
  expect(opened).toBe('limits')
  expect(r.text).toContain('Usage limits pane opened')
})
