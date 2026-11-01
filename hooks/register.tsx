import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ExplorerView, Mode } from '../types'
import { baseOf, isUnder, isWin, join, norm, parentOf, rel, validName } from './paths'

type $ = EngineInterface

const PANE = 'directory'
const TITLE = 'Directory'
const ROW = 'row:'
const MAX_ROWS = 2000 // ponytail: flat cap, virtualize if huge expanded trees matter
const HIDDEN = new Set(['.git'])
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const initial: ExplorerView = { expanded: [], mode: { kind: 'idle' }, touched: [], tick: 0 }
const view = atom({ plugin: 'directory', key: 'view' } as const, initial, { shape: 'view-1' })

// `guide` is the indent drawn before the row: │ ├ └ like VS Code's indent guides.
type Row = { path: string; name: string; depth: number; isDir: boolean; guide: string }

async function collect($: $, dir: string, depth: number, open: Set<string>, out: Row[], prefix = '') {
  const entries = await $.fs.list(dir).catch(() => [])
  const sorted = entries
    .filter(x => !HIDDEN.has(x.name))
    .sort(
      (a, b) =>
        Number(b.kind === 'dir') - Number(a.kind === 'dir') ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  for (const [i, x] of sorted.entries()) {
    if (out.length >= MAX_ROWS) return
    const path = join(dir, x.name)
    const isDir = x.kind === 'dir'
    const isLast = i === sorted.length - 1
    const guide = depth === 0 ? '' : prefix + (isLast ? '└ ' : '├ ')
    out.push({ path, name: x.name, depth, isDir, guide })
    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '  ' : '│ ')
    if (isDir && open.has(path)) await collect($, path, depth + 1, open, out, childPrefix)
  }
}

// Host file ops. Paths travel in env vars, never in the command text, so no name can inject.
async function run($: $, ps: string, posix: string[], a: string, b = '') {
  const r = isWin(a)
    ? await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps], {
        env: { FX_A: a, FX_B: b },
      })
    : await $.process.run(posix)
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.exitCode}`)
}

const mkdir = ($: $, p: string) =>
  run($, '[IO.Directory]::CreateDirectory($env:FX_A) | Out-Null', ['mkdir', '-p', '--', p], p)

const move = ($: $, a: string, b: string) =>
  run(
    $,
    'if (Test-Path -LiteralPath $env:FX_A -PathType Container) { [IO.Directory]::Move($env:FX_A, $env:FX_B) } else { [IO.File]::Move($env:FX_A, $env:FX_B) }',
    ['mv', '-n', '--', a, b],
    a,
    b,
  )

const copy = ($: $, a: string, b: string) =>
  run($, 'Copy-Item -LiteralPath $env:FX_A -Destination $env:FX_B -Recurse', ['cp', '-R', '--', a, b], a, b)

// Windows: Recycle Bin. Elsewhere: `trash` if installed, else permanent rm.
async function remove($: $, p: string) {
  if (isWin(p)) {
    return run(
      $,
      "Add-Type -AssemblyName Microsoft.VisualBasic; $f = [Microsoft.VisualBasic.FileIO.FileSystem]; if (Test-Path -LiteralPath $env:FX_A -PathType Container) { $f::DeleteDirectory($env:FX_A, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { $f::DeleteFile($env:FX_A, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
      [],
      p,
    )
  }
  const trashed = await $.process.run(['trash', p]).then(r => r.exitCode === 0, () => false)
  if (!trashed) await run($, '', ['rm', '-rf', '--', p], p)
}

async function openExternal($: $, p: string) {
  if (isWin(p)) return run($, 'Invoke-Item -LiteralPath $env:FX_A', [], p)
  await run($, '', ['xdg-open', p], p).catch(() => run($, '', ['open', p], p))
}

const isDirPath = ($: $, p: string) => $.fs.stat(p).then(s => s.kind === 'dir', () => false)

async function freeName($: $, dir: string, name: string) {
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  let candidate = name
  for (let i = 1; await $.fs.exists(join(dir, candidate)); i++) {
    candidate = `${stem} copy${i > 1 ? ` ${i}` : ''}${ext}`
  }
  return join(dir, candidate)
}

const setMode = ($: $, mode: Mode) => update($, view, v => ({ ...v, mode }))
const refresh = ($: $) => update($, view, v => ({ ...v, tick: v.tick + 1 }))
const fail = ($: $, err: unknown) => $.ui.toast(`Explorer: ${err instanceof Error ? err.message : String(err)}`)

async function select($: $, path: string) {
  const parent = parentOf(path)
  await update($, view, v => ({
    ...v,
    selected: path,
    expanded: v.expanded.includes(parent) ? v.expanded : [...v.expanded, parent],
    tick: v.tick + 1,
  }))
  await $.ui.focus({ requestId: PANE, key: ROW + path }).catch(() => {})
}

// Where a new file/folder goes: the selected folder, or the selected file's folder, or the root.
async function targetDir($: $, root: string) {
  const { selected } = await read($, view)
  if (!selected || !(await $.fs.exists(selected))) return root
  return (await isDirPath($, selected)) ? selected : parentOf(selected)
}

async function create($: $, dir: string, name: string, isFolder: boolean) {
  if (!validName(name, true)) throw new Error(`invalid name "${name}"`)
  const path = join(dir, name.replace(/[\\/]+/g, isWin(dir) ? '\\' : '/'))
  if (await $.fs.exists(path)) throw new Error(`${baseOf(path)} already exists`)
  if (isFolder) await mkdir($, path)
  else await $.fs.write(path, '')
  await update($, view, v => ({ ...v, expanded: [...new Set([...v.expanded, dir])] }))
  await select($, path)
}

async function rename($: $, path: string, name: string) {
  if (!validName(name, false)) throw new Error(`invalid name "${name}"`)
  const dest = join(parentOf(path), name)
  if (dest === path) return
  if (norm(dest) !== norm(path) && (await $.fs.exists(dest))) throw new Error(`${name} already exists`)
  await move($, path, dest)
  await update($, view, v => ({
    ...v,
    expanded: v.expanded.map(p => (isUnder(p, path) ? dest + p.slice(path.length) : p)),
  }))
  await select($, dest)
}

async function paste($: $, root: string) {
  const { clip } = await read($, view)
  if (!clip) throw new Error('nothing to paste: copy (c) or cut (x) first')
  if (!(await $.fs.exists(clip.path))) throw new Error(`${baseOf(clip.path)} no longer exists`)
  const dir = await targetDir($, root)
  if (isUnder(norm(dir), norm(clip.path))) throw new Error('cannot paste a folder into itself')
  const dest = await freeName($, dir, baseOf(clip.path))
  if (clip.isCut) await move($, clip.path, dest)
  else await copy($, clip.path, dest)
  if (clip.isCut) await update($, view, v => ({ ...v, clip: undefined }))
  await select($, dest)
}

async function activate($: $, row: Row, root: string) {
  await update($, view, v => ({ ...v, selected: row.path }))
  if (row.isDir) {
    await update($, view, v => ({
      ...v,
      expanded: v.expanded.includes(row.path) ? v.expanded.filter(p => p !== row.path) : [...v.expanded, row.path],
    }))
  } else {
    await $.prompt.fill({ text: `@${rel(root, row.path)} `, mode: 'insert' })
  }
}

const guard = ($: $, work: () => Promise<unknown>) => () => void work().catch(err => fail($, err))

// File-type icon colors, VS Code-ish. A colored dot reads as an icon on any font (no Nerd Font needed).
const EXT_COLOR: Record<string, string> = {
  ts: '#3b8eea', tsx: '#3b8eea', mts: '#3b8eea', cts: '#3b8eea',
  js: '#e5c07b', jsx: '#e5c07b', mjs: '#e5c07b', cjs: '#e5c07b',
  json: '#d19a66', jsonc: '#d19a66', lock: '#7f848e',
  md: '#56b6c2', mdx: '#56b6c2', txt: '#abb2bf',
  py: '#4fa3e0', go: '#56b6c2', rs: '#d19a66', java: '#e06c75', rb: '#e06c75', php: '#a48fe0',
  css: '#c678dd', scss: '#c678dd', html: '#e06c75', vue: '#98c379', svelte: '#e06c75',
  yml: '#98c379', yaml: '#98c379', toml: '#98c379', ini: '#98c379', env: '#e5c07b',
  sh: '#98c379', ps1: '#4fa3e0', bat: '#98c379',
  png: '#c678dd', jpg: '#c678dd', jpeg: '#c678dd', gif: '#c678dd', svg: '#e5c07b', ico: '#c678dd',
}
const iconColor = (name: string) => EXT_COLOR[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? '#7f848e'
const isQuiet = (name: string) => name.startsWith('.') || name.endsWith('.lock') || name === 'node_modules'
const fit = (text: string, width: number) =>
  text.length <= width ? text : width <= 1 ? '…' : `${text.slice(0, width - 1)}…`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'directory', description: 'Open and focus the Directory pane' })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'directory' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Directory opened.' }
  })

  // Highlight what Claude edits, and redraw after anything that may touch the disk.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const fp = (e as { file_path?: unknown }).file_path
    if (EDIT_TOOLS.has(String(e.tool)) && typeof fp === 'string') {
      const root = await $.session.root()
      const abs = /^([A-Za-z]:|[\\/])/.test(fp) ? fp : join(root, fp)
      await update($, view, v => ({ ...v, touched: [...new Set([...v.touched, norm(abs)])], tick: v.tick + 1 }))
    } else if (!['Read', 'Glob', 'Grep'].includes(String(e.tool))) {
      await refresh($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    const key = e.element
    if (key?.startsWith(ROW)) await update($, view, v => ({ ...v, selected: key.slice(ROW.length) }))

    return moved
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Directory needs a terminal or desktop session.</Text>
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns ?? e.viewport?.columns ?? 40)
    const root = await $.session.root()
    const v = await read($, view)
    const rows: Row[] = []
    await collect($, root, 0, new Set(v.expanded), rows)
    const touched = v.touched
    const isTouched = (r: Row) =>
      r.isDir ? touched.some(t => t.startsWith(norm(r.path) + '/')) : touched.includes(norm(r.path))
    const shown = (p: string) => rel(root, p) || baseOf(root)
    const act = (work: () => Promise<unknown>) => guard($, work)
    const rule = <Text color="subtle">{'─'.repeat(width)}</Text>

    const tool = (hotkey: string, label: string, work: () => Promise<unknown>, isPrimary = false) => (
      <Button key={`tb:${hotkey}`} plain hotkey={hotkey} dimColor={!isPrimary} onPress={act(work)}>
        {label}
      </Button>
    )

    const needsSelection = async () => {
      const { selected } = await read($, view)
      if (!selected || !(await $.fs.exists(selected))) throw new Error('select a file or folder first')
      return selected
    }

    const cancel = (
      <Button key="cancel" plain hotkey="q" dimColor onPress={act(() => setMode($, { kind: 'idle' }))}>
        cancel
      </Button>
    )

    const mode = v.mode
    const dialog =
      mode.kind === 'newFile' || mode.kind === 'newFolder' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Text bold color="claude">
            {mode.kind === 'newFile' ? '+ New file' : '+ New folder'}
            <Text dimColor> in {fit(shown(mode.dir), width - 20)}/</Text>
          </Text>
          <Input
            key="name"
            autoFocus
            placeholder={mode.kind === 'newFile' ? 'name.ts  (a/b.ts makes folders)' : 'folder name'}
            submitLabel="create"
            onSubmit={value =>
              guard($, async () => {
                await setMode($, { kind: 'idle' })
                if (value.trim()) await create($, mode.dir, value.trim(), mode.kind === 'newFolder')
              })()
            }
          />
          {cancel}
        </Box>
      ) : mode.kind === 'rename' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Text bold color="claude">
            ✎ Rename <Text dimColor>{fit(shown(mode.path), width - 14)}</Text>
          </Text>
          <Input
            key="name"
            autoFocus
            value={baseOf(mode.path)}
            submitLabel="rename"
            onSubmit={value =>
              guard($, async () => {
                await setMode($, { kind: 'idle' })
                if (value.trim()) await rename($, mode.path, value.trim())
              })()
            }
          />
          {cancel}
        </Box>
      ) : mode.kind === 'delete' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="error" paddingX={1}>
          <Text bold color="error">
            ✕ Delete {fit(shown(mode.path), width - 14)}?
          </Text>
          <Text dimColor>{isWin(root) ? 'It goes to the Recycle Bin.' : 'Uses trash if installed, else it is permanent.'}</Text>
          <Box flexDirection="row" columnGap={2}>
            <Button
              key="yes"
              plain
              hotkey="y"
              autoFocus
              onPress={act(async () => {
                await setMode($, { kind: 'idle' })
                await remove($, mode.path)
                await update($, view, s => ({ ...s, selected: parentOf(mode.path), tick: s.tick + 1 }))
              })}
            >
              <Text color="error">delete</Text>
            </Button>
            {cancel}
          </Box>
        </Box>
      ) : null

    const toolbar = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {tool('n', 'new file', async () => setMode($, { kind: 'newFile', dir: await targetDir($, root) }), true)}
        {tool('f', 'new folder', async () => setMode($, { kind: 'newFolder', dir: await targetDir($, root) }), true)}
        {tool('r', 'rename', async () => setMode($, { kind: 'rename', path: await needsSelection() }), true)}
        {tool('d', 'delete', async () => setMode($, { kind: 'delete', path: await needsSelection() }), true)}
        {tool('c', 'copy', async () => {
          const path = await needsSelection()
          await update($, view, s => ({ ...s, clip: { path, isCut: false } }))
        })}
        {tool('x', 'cut', async () => {
          const path = await needsSelection()
          await update($, view, s => ({ ...s, clip: { path, isCut: true } }))
        })}
        {tool('v', 'paste', () => paste($, root))}
        {tool('o', 'open', async () => openExternal($, await needsSelection()))}
        {tool('z', 'collapse', () => update($, view, s => ({ ...s, expanded: [] })))}
        {tool('u', 'refresh', () => refresh($))}
      </Box>
    )

    const row = (r: Row) => {
      const isOpen = r.isDir && v.expanded.includes(r.path)
      const isCut = v.clip?.isCut === true && v.clip.path === r.path
      const isEdited = isTouched(r)
      const room = width - r.guide.length - 2 - (isEdited ? 2 : 0)
      return (
        <Button key={ROW + r.path} plain onPress={act(() => activate($, r, root))}>
          <Text color="subtle">{r.guide}</Text>
          {r.isDir ? (
            <Text color={isOpen ? 'claude' : 'subtle'}>{isOpen ? '▾ ' : '▸ '}</Text>
          ) : (
            <Text color={iconColor(r.name)}>{'● '}</Text>
          )}
          <Text
            color={isEdited ? 'warning' : undefined}
            dimColor={isCut || (isQuiet(r.name) && !isEdited)}
            italic={isCut}
            bold={r.path === v.selected}
          >
            {fit(r.name, room)}
          </Text>
          {isEdited ? <Text color="warning">{r.isDir ? ' •' : ' M'}</Text> : ''}
        </Button>
      )
    }

    const status = [
      v.selected ? fit(shown(v.selected), width) : 'nothing selected',
      v.clip ? `${v.clip.isCut ? '✂ cut' : '⧉ copied'} ${baseOf(v.clip.path)}` : '',
      touched.length ? `${touched.length} edited by Claude` : '',
    ].filter(Boolean)

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold color="claude">◆ DIRECTORY</Text>
          <Text dimColor> · {fit(baseOf(root), width - 14)}</Text>
        </Text>
        {dialog ?? toolbar}
        {rule}
        {rows.length === 0 && <Text dimColor>This folder is empty. Press n to create a file.</Text>}
        {rows.map(row)}
        {rows.length >= MAX_ROWS && <Text dimColor>… more than {MAX_ROWS} rows; press z to collapse.</Text>}
        {rule}
        {status.map(s => (
          <Text dimColor>{s}</Text>
        ))}
        <Text color="subtle">enter open · @ on files · esc back to chat</Text>
      </Box>
    )
  })
}

