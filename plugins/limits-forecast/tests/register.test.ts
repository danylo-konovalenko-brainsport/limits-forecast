import { expect, mock, test } from 'claude-code/testing'

test('/limits-forecast opens the pane where the mod is drawn', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  let opened = ''
  on('ui.open', async (_$, e) => {
    opened = (e as { id: string }).id
    return { value: undefined } as never
  })
  // The terminal draws the mod (here its pane, as the band would).
  const pane = await $.ui.mount({ plugin: 'limits-forecast', surface: 'terminal', component: 'Pane', requestId: 'limits', props: {} } as never)
  await pane.unmount()
  const r = await $.command.run({ command: 'limits-forecast', args: '' } as never)
  expect(opened).toBe('limits')
  expect(r.text).toContain('Usage limits pane opened')
})

test('/limits-forecast prints the report where nothing of the mod is drawn (VS Code)', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  let opens = 0
  on('ui.open', async () => {
    opens++
    return { value: undefined } as never
  })
  const r = await $.command.run({ command: 'limits-forecast', args: '' } as never)
  expect(opens).toBe(0)
  expect(r.text).not.toContain('pane opened')
  expect(r.text).toContain('Usage limits')
  // Asked for as text, the same.
  const t = await $.command.run({ command: 'limits-forecast', args: 'text' } as never)
  expect(opens).toBe(0)
  expect(t.text).toContain('Usage limits')
})
