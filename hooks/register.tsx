import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ExplorerView, Mode } from '../types'
import { baseOf, isUnder, isWin, join, norm, parentOf, rel, validName } from './paths'

type $ = EngineInterface

const PANE = 'explorer'
const TITLE = 'Explorer'
const ROW = 'row:'
const MAX_ROWS = 2000 // ponytail: flat cap, virtualize if huge expanded trees matter
const HIDDEN = new Set(['.git'])
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const initial: ExplorerView = { expanded: [], mode: { kind: 'idle' }, touched: [], tick: 0 }
const view = atom({ plugin: 'file-explorer', key: 'view' } as const, initial, { shape: 'view-1' })

type Row = { path: string; name: string; depth: number; isDir: boolean }

async function collect($: $, dir: string, depth: number, open: Set<string>, out: Row[]) {
  const entries = await $.fs.list(dir).catch(() => [])
  const sorted = entries
    .filter(x => !HIDDEN.has(x.name))
    .sort(
      (a, b) =>
        Number(b.kind === 'dir') - Number(a.kind === 'dir') ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  for (const x of sorted) {
    if (out.length >= MAX_ROWS) return
    const path = join(dir, x.name)
    const isDir = x.kind === 'dir'
    out.push({ path, name: x.name, depth, isDir })
    if (isDir && open.has(path)) await collect($, path, depth + 1, open, out)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'explorer', description: 'Open and focus the file explorer pane' })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'explorer' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Explorer opened.' }
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
      return <Text dimColor>The explorer needs a terminal or desktop session.</Text>
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const root = await $.session.root()
    const v = await read($, view)
    const rows: Row[] = []
    await collect($, root, 0, new Set(v.expanded), rows)
    const touched = v.touched
    const isTouched = (r: Row) =>
      r.isDir ? touched.some(t => t.startsWith(norm(r.path) + '/')) : touched.includes(norm(r.path))
    const shown = (p: string) => rel(root, p) || baseOf(root)
    const act = (work: () => Promise<unknown>) => guard($, work)

    const tool = (hotkey: string, label: string, work: () => Promise<unknown>) => (
      <Button key={`tb:${hotkey}`} plain hotkey={hotkey} onPress={act(work)}>
        {label}
      </Button>
    )

    const mode = v.mode
    const prompt =
      mode.kind === 'newFile' || mode.kind === 'newFolder' ? (
        <Box flexDirection="column">
          <Input
            key="name"
            autoFocus
            label={`New ${mode.kind === 'newFile' ? 'file' : 'folder'} in ${shown(mode.dir)}/ `}
            placeholder="name (a/b.ts makes folders)"
            submitLabel="create"
            onSubmit={value =>
              guard($, async () => {
                await setMode($, { kind: 'idle' })
                if (value.trim()) await create($, mode.dir, value.trim(), mode.kind === 'newFolder')
              })()
            }
          />
          <Button key="cancel" plain onPress={act(() => setMode($, { kind: 'idle' }))}>
            cancel
          </Button>
        </Box>
      ) : mode.kind === 'rename' ? (
        <Box flexDirection="column">
          <Input
            key="name"
            autoFocus
            label="Rename to "
            value={baseOf(mode.path)}
            submitLabel="rename"
            onSubmit={value =>
              guard($, async () => {
                await setMode($, { kind: 'idle' })
                if (value.trim()) await rename($, mode.path, value.trim())
              })()
            }
          />
          <Button key="cancel" plain onPress={act(() => setMode($, { kind: 'idle' }))}>
            cancel
          </Button>
        </Box>
      ) : mode.kind === 'delete' ? (
        <Box flexDirection="column">
          <Text color="error">
            Delete {shown(mode.path)}?{isWin(root) ? ' (to Recycle Bin)' : ''}
          </Text>
          <Box flexDirection="row" gap={2}>
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
              delete
            </Button>
            <Button key="no" plain hotkey="n" onPress={act(() => setMode($, { kind: 'idle' }))}>
              cancel
            </Button>
          </Box>
        </Box>
      ) : null

    const needsSelection = async () => {
      const { selected } = await read($, view)
      if (!selected || !(await $.fs.exists(selected))) throw new Error('select a file or folder first')
      return selected
    }

    return (
      <Box flexDirection="column">
        <Text bold>{baseOf(root).toUpperCase()}</Text>
        {prompt ?? (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {tool('n', 'file', async () => setMode($, { kind: 'newFile', dir: await targetDir($, root) }))}
            {tool('f', 'folder', async () => setMode($, { kind: 'newFolder', dir: await targetDir($, root) }))}
            {tool('r', 'rename', async () => setMode($, { kind: 'rename', path: await needsSelection() }))}
            {tool('d', 'delete', async () => setMode($, { kind: 'delete', path: await needsSelection() }))}
            {tool('c', 'copy', async () => {
              const path = await needsSelection()
              await update($, view, s => ({ ...s, clip: { path, isCut: false } }))
              $.ui.toast(`Copied ${baseOf(path)}`)
            })}
            {tool('x', 'cut', async () => {
              const path = await needsSelection()
              await update($, view, s => ({ ...s, clip: { path, isCut: true } }))
              $.ui.toast(`Cut ${baseOf(path)}`)
            })}
            {tool('v', 'paste', () => paste($, root))}
            {tool('o', 'open', async () => openExternal($, await needsSelection()))}
            {tool('z', 'collapse', () => update($, view, s => ({ ...s, expanded: [] })))}
            {tool('u', 'refresh', () => refresh($))}
          </Box>
        )}
        {rows.length === 0 && <Text dimColor>Empty folder.</Text>}
        {rows.map(r => (
          <Button key={ROW + r.path} plain onPress={act(() => activate($, r, root))}>
            {'  '.repeat(r.depth)}
            {r.isDir ? (v.expanded.includes(r.path) ? '▾ ' : '▸ ') : '  '}
            <Text
              color={isTouched(r) ? 'warning' : undefined}
              dimColor={v.clip?.isCut === true && v.clip.path === r.path}
              bold={r.path === v.selected}
            >
              {r.name}
            </Text>
          </Button>
        ))}
        {rows.length >= MAX_ROWS && <Text dimColor>… more than {MAX_ROWS} rows; collapse some folders.</Text>}
      </Box>
    )
  })
}
