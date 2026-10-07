import { expect, test } from 'claude-code/testing'

test('/limits opens the pane', async ($, on) => {
  let opened = ''
  on('ui.open', async (_$, e) => {
    opened = (e as { id: string }).id
    return { value: undefined } as never
  })
  const r = await $.command.run({ command: 'limits', args: '' })
  expect(opened).toBe('limits')
  expect(r.text).toContain('Usage limits pane opened')
})
