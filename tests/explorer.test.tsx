import { expect, test } from 'claude-code/testing'

import { isUnder, join, rel, validName } from '../hooks/paths'

const PANE = {
  plugin: 'directory',
  component: 'Pane',
  requestId: 'directory',
  props: {
    title: 'Directory',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })

test('path helpers', async () => {
  expect(join('D:\\proj', 'a.ts')).toBe('D:\\proj\\a.ts')
  expect(join('/proj/', 'a.ts')).toBe('/proj/a.ts')
  expect(rel('D:\\proj', 'D:\\proj\\src\\a.ts')).toBe('src/a.ts')
  expect(isUnder('/proj/src/a', '/proj/src')).toBe(true)
  expect(isUnder('/proj/srcx', '/proj/src')).toBe(false)
  expect(validName('src/new.ts', true)).toBe(true)
  expect(validName('src/new.ts', false)).toBe(false)
  expect(validName('../escape', true)).toBe(false)
  expect(validName('bad:name', false)).toBe(false)
})

test('lists folders first, hides .git, expands on press', async ($, on) => {
  on('session.root', () => ({ value: '/proj' }))
  on('fs.list', (_, e) => {
    return !e.path.endsWith('src')
      ? { value: [entry('z.md', 'file'), entry('.git', 'dir'), entry('src', 'dir'), entry('a.ts', 'file')] }
      : { value: [entry('index.ts', 'file')] }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Button' })).map(b => b.text?.trimEnd()).filter(t => /\w\.(ts|md)|src/.test(t ?? ''))
    expect(texts.join('|')).toBe('▸ src|  a.ts|  z.md')
    expect(await ui.find({ type: 'Button', text: /\.git/ })).toBe(undefined)

    // The kit places the root per platform (C:\proj on Windows): take the row's own key.
    const src = await ui.find({ type: 'Button', text: /src/ })
    await ui.press({ key: src!.key! })
    expect((await ui.find({ type: 'Button', text: /index\.ts/ }))?.text?.trimEnd()).toBe('│   index.ts')
    await ui.press({ key: src!.key! }) // collapse again for the next surface
    await ui.unmount()
  }
})

test("Claude's edits show in This session and in the gutter", async ($, on) => {
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [entry('a.ts', 'file')] }))
  on('tool.call', () => ({ result: {} }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /This session/ })).toBe(undefined)

  const row = await ui.find({ type: 'Button', text: /a\.ts/ })
  const file = row!.key!.slice('row:'.length)
  await $.tool.call({ tool: 'Edit', file_path: file, old_string: 'x', new_string: 'y' })

  expect((await ui.find({ type: 'Text', text: /This session/ }))?.text).toBe('This session')
  expect((await ui.find({ type: 'Button', text: /edited/ }))?.text).toMatch(/◆ edited\s+a\.ts\s+now/)
  expect((await ui.find({ type: 'Button', key: row!.key! }))?.text).toMatch(/a\.ts\s+◆$/)
  await ui.unmount()
})
