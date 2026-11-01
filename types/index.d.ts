export type Mode =
  | { kind: 'idle' }
  | { kind: 'newFile' | 'newFolder'; dir: string }
  | { kind: 'rename'; path: string }
  | { kind: 'delete'; path: string }

export type Clip = { path: string; isCut: boolean }

/** One thing Claude did to a file this session, newest first in `trail`. */
export type TrailItem = { verb: 'created' | 'edited' | 'read'; path: string; at: number }

export type ExplorerView = {
  expanded: string[]
  selected?: string
  mode: Mode
  clip?: Clip
  touched: string[]
  trail: TrailItem[]
  showMore: boolean
  tick: number
}

declare module 'claude-code' {
  interface PluginState {
    'directory': { view: Shaped<ExplorerView> }
  }
}
