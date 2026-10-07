import { expect, test } from 'claude-code/testing'

test('/token-speed command opens the pane', async ($, on) => {
  let opened = ''
  on('ui.open', async (_$, e) => {
    opened = (e as { id: string }).id
    return { value: undefined } as never
  })
  const r = await $.command.run({ command: 'token-speed', args: '' })
  expect(opened).toBe('token-speed')
  expect(r.text).toContain('Token speed pane opened')
})
