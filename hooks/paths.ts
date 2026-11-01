// Path helpers. The module has no Node, so no `path` module: these cover
// the absolute paths the explorer builds from the session root.

export const isWin = (p: string) => /^[A-Za-z]:/.test(p) || p.startsWith('\\\\')

const sepOf = (p: string) => (isWin(p) ? '\\' : '/')

const lastSep = (p: string) => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))

export const join = (dir: string, name: string) => dir.replace(/[\\/]+$/, '') + sepOf(dir) + name

export const parentOf = (p: string) => p.slice(0, lastSep(p))

export const baseOf = (p: string) => p.slice(lastSep(p) + 1)

/** `p` is `dir` itself or inside it. */
export const isUnder = (p: string, dir: string) =>
  p === dir || (p.startsWith(dir) && /^[\\/]/.test(p.slice(dir.length)))

/** Root-relative, forward slashes: what an @mention takes. */
export const rel = (root: string, p: string) =>
  isUnder(p, root) ? p.slice(root.length).replace(/^[\\/]+/, '').replaceAll('\\', '/') : p

/** Comparable form: forward slashes, case folded on Windows. */
export const norm = (p: string) => {
  const slashed = p.replaceAll('\\', '/').replace(/\/+$/, '')
  return isWin(p) ? slashed.toLowerCase() : slashed
}

/** A name the user typed. `nested` allows `a/b.ts` (new file/folder), never `..`. */
export const validName = (name: string, nested: boolean) => {
  const parts = nested ? name.split(/[\\/]/) : [name]
  return parts.every(
    part => part !== '' && part !== '.' && part !== '..' && !/[\\/:*?"<>|\x00-\x1f]/.test(part) && !/[ .]$/.test(part),
  )
}
