import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ExplorerView, Mode, TrailItem } from '../types'
import { baseOf, isUnder, isWin, join, norm, parentOf, rel, validName } from './paths'

type $ = EngineInterface

const PANE = 'directory'
const TITLE = 'Directory'
const ROW = 'row:'
const MAX_ROWS = 2000 // ponytail: flat cap, virtualize if huge expanded trees matter
const HIDDEN = new Set(['.git'])
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const initial: ExplorerView = { expanded: [], mode: { kind: 'idle' }, touched: [], trail: [], showMore: false, tick: 0 }
const view = atom({ plugin: 'directory', key: 'view' } as const, initial, { shape: 'view-2' })

// `guide` is the indent drawn before the row: one │ per level, like VS Code's indent guides.
type Row = { path: string; name: string; depth: number; isDir: boolean; guide: string }

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
    out.push({ path, name: x.name, depth, isDir, guide: '│ '.repeat(depth) })
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

const TRAIL_SHOWN = 5
const isQuiet = (name: string) => name.startsWith('.') || name.endsWith('.lock') || name === 'node_modules'
const fit = (text: string, width: number) =>
  text.length <= width ? text : width <= 1 ? '…' : `${text.slice(0, width - 1)}…`
const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - text.length))

function ago(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

// Open every folder between the root and `path`, then select and focus it.
async function reveal($: $, root: string, path: string) {
  const parents: string[] = []
  for (let p = parentOf(path); p.length > root.length && isUnder(p, root); p = parentOf(p)) parents.push(p)
  await update($, view, v => ({ ...v, expanded: [...new Set([...v.expanded, ...parents])], selected: path }))
  await $.ui.focus({ requestId: PANE, key: ROW + path }).catch(() => {})
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'directory', description: 'Open and focus the Directory pane' })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'directory' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Directory opened' }
  })

  // Claude's trail: what it read, created and edited, and a redraw after anything that may touch the disk.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const fp = (e as { file_path?: unknown }).file_path
    const isFileTool = typeof fp === 'string' && (EDIT_TOOLS.has(tool) || tool === 'Read')
    const root = isFileTool ? await $.session.root() : ''
    const abs = isFileTool ? (/^([A-Za-z]:|[\\/])/.test(fp) ? fp : join(root, fp)) : ''
    const existed = tool === 'Write' ? await $.fs.exists(abs) : true
    const ran = await next(e)
    if (isFileTool && !(ran as { isError?: boolean }).isError) {
      const verb: TrailItem['verb'] = tool === 'Read' ? 'read' : existed ? 'edited' : 'created'
      await update($, view, v => ({
        ...v,
        trail: [{ verb, path: abs, at: Date.now() }, ...v.trail.filter(t => norm(t.path) !== norm(abs))].slice(0, 50),
        touched: verb === 'read' ? v.touched : [...new Set([...v.touched, norm(abs)])],
        tick: v.tick + 1,
      }))
    } else if (!['Read', 'Glob', 'Grep'].includes(tool)) {
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
      return <Text dimColor>Directory needs a terminal or desktop session</Text>
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const width = Math.max(24, e.props.bodyColumns ?? e.viewport?.columns ?? 40)
    const root = await $.session.root()
    const v = await read($, view)
    const rows: Row[] = []
    await collect($, root, 0, new Set(v.expanded), rows)
    const now = Date.now()
    const touched = v.touched
    const hasEdit = (r: Row) =>
      r.isDir ? touched.some(t => t.startsWith(norm(r.path) + '/')) : touched.includes(norm(r.path))
    const shown = (p: string) => rel(root, p) || baseOf(root)
    const act = (work: () => Promise<unknown>) => guard($, work)
    const rule = <Text color="subtle">{'─'.repeat(width)}</Text>

    const needsSelection = async () => {
      const { selected } = await read($, view)
      if (!selected || !(await $.fs.exists(selected))) throw new Error('select a file or folder first')
      return selected
    }

    const key = (hotkey: string, label: string, work: () => Promise<unknown>) => (
      <Button key={`k:${hotkey}`} plain hotkey={hotkey} dimColor onPress={act(work)}>
        {label}
      </Button>
    )

    const cancel = (
      <Button key="cancel" plain hotkey="q" dimColor onPress={act(() => setMode($, { kind: 'idle' }))}>
        cancel
      </Button>
    )

    // Dialogs replace the key row while open: quiet frame, red only for delete.
    const mode = v.mode
    const dialog =
      mode.kind === 'newFile' || mode.kind === 'newFolder' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
          <Text>
            {mode.kind === 'newFile' ? 'New file' : 'New folder'}
            <Text dimColor> in {fit(shown(mode.dir), width - 18)}</Text>
          </Text>
          <Input
            key="name"
            autoFocus
            placeholder={mode.kind === 'newFile' ? 'name.ts, or a/b.ts' : 'name'}
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
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
          <Text>
            Rename <Text dimColor>{fit(shown(mode.path), width - 12)}</Text>
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
          <Text>
            Delete <Text bold>{fit(shown(mode.path), width - 12)}</Text>
          </Text>
          <Text dimColor>{isWin(root) ? 'Moves it to the Recycle Bin' : 'Uses trash if installed, otherwise permanent'}</Text>
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

    // This session: Claude's trail, the one place with color. Folds away while empty.
    const trail = v.trail.slice(0, TRAIL_SHOWN)
    const session =
      trail.length === 0 ? null : (
        <Box flexDirection="column">
          <Text dimColor>This session</Text>
          {trail.map(t => {
            const when = ago(t.at, now)
            const isChange = t.verb !== 'read'
            return (
              <Button key={`trail:${t.path}`} plain onPress={act(() => reveal($, root, t.path))}>
                <Text color={isChange ? 'claude' : 'subtle'}>{isChange ? '◆ ' : '  '}</Text>
                <Text dimColor>{pad(t.verb, 8)}</Text>
                {pad(fit(shown(t.path), width - 16), width - 16)}
                <Text dimColor>{when.padStart(4)}</Text>
              </Button>
            )
          })}
          {v.trail.length > TRAIL_SHOWN && <Text dimColor>  {v.trail.length - TRAIL_SHOWN} earlier</Text>}
          {rule}
        </Box>
      )

    // A row: guides, chevron, name, then Claude's mark in the right gutter.
    const row = (r: Row) => {
      const isOpen = r.isDir && v.expanded.includes(r.path)
      const isCut = v.clip?.isCut === true && v.clip.path === r.path
      const isEdited = hasEdit(r)
      const lead = r.guide + (r.isDir ? (isOpen ? '▾ ' : '▸ ') : '  ')
      const room = width - lead.length - 3
      const name = fit(r.name, room)
      return (
        <Button key={ROW + r.path} plain onPress={act(() => activate($, r, root))}>
          <Text color="subtle">{lead}</Text>
          <Text dimColor={isCut || isQuiet(r.name)} bold={r.path === v.selected}>
            {name}
          </Text>
          {' '.repeat(Math.max(1, room - name.length + 1))}
          {isCut ? (
            <Text dimColor>✂</Text>
          ) : isEdited ? (
            <Text color={r.isDir ? 'subtle' : 'claude'}>◆</Text>
          ) : (
            ' '
          )}
        </Button>
      )
    }

    const keys = (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {key('n', 'new', async () => setMode($, { kind: 'newFile', dir: await targetDir($, root) }))}
          {key('f', 'folder', async () => setMode($, { kind: 'newFolder', dir: await targetDir($, root) }))}
          {key('r', 'rename', async () => setMode($, { kind: 'rename', path: await needsSelection() }))}
          {key('d', 'delete', async () => setMode($, { kind: 'delete', path: await needsSelection() }))}
          {key('m', v.showMore ? 'less' : 'more', () => update($, view, s => ({ ...s, showMore: !s.showMore })))}
        </Box>
        {v.showMore && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {key('c', 'copy', async () => {
              const path = await needsSelection()
              await update($, view, s => ({ ...s, clip: { path, isCut: false } }))
            })}
            {key('x', 'cut', async () => {
              const path = await needsSelection()
              await update($, view, s => ({ ...s, clip: { path, isCut: true } }))
            })}
            {key('v', 'paste', () => paste($, root))}
            {key('o', 'open', async () => openExternal($, await needsSelection()))}
            {key('z', 'collapse', () => update($, view, s => ({ ...s, expanded: [] })))}
            {key('u', 'refresh', () => refresh($))}
          </Box>
        )}
      </Box>
    )

    const status = v.clip
      ? `${v.clip.isCut ? 'Cut' : 'Copied'} ${fit(baseOf(v.clip.path), width - 22)}, v to paste`
      : v.selected
        ? fit(shown(v.selected), width)
        : 'Enter adds a file to your prompt'

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{fit(baseOf(root), width - 2)}</Text>
        </Text>
        {rule}
        {session}
        {rows.length === 0 && <Text dimColor>Empty folder, n to create a file</Text>}
        {rows.map(row)}
        {rows.length >= MAX_ROWS && <Text dimColor>Over {MAX_ROWS} rows shown, z collapses all</Text>}
        {rule}
        <Text dimColor>{status}</Text>
        {dialog ?? keys}
      </Box>
    )
  })
}

