export type Mode =
  | { kind: 'idle' }
  | { kind: 'newFile' | 'newFolder'; dir: string }
  | { kind: 'rename'; path: string }
  | { kind: 'delete'; path: string }

export type Clip = { path: string; isCut: boolean }

export type ExplorerView = {
  expanded: string[]
  selected?: string
  mode: Mode
  clip?: Clip
  touched: string[]
  tick: number
}

declare module 'claude-code' {
  interface PluginState {
    'file-explorer': { view: Shaped<ExplorerView> }
  }
}
