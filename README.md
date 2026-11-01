# Directory

A VS Code-style file explorer for Claude Code, called Directory. It docks beside the chat, in the same terminal, so you can browse and manage your project's files without leaving your Claude session.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install directory --marketplace umarfarooque88/directory
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install directory --marketplace umarfarooque88/directory
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `umarfarooque88/directory`, then **Add plugin**.

## Use

The pane opens by itself at session start on a wide terminal (about 144 columns, 110 once you have opened it before). Type `/directory` to open it at any width and move the keyboard into it. Esc hands the keyboard back to the prompt.

| Key | Action |
| --- | --- |
| Up / Down | Move through the tree |
| Enter | Folder: expand or collapse. File: insert `@path` into your prompt |
| `n` | New file in the selected folder (`a/b.ts` creates the folders too) |
| `f` | New folder |
| `r` | Rename |
| `d` | Delete, after a confirm (to the Recycle Bin on Windows; `trash` if installed elsewhere, else permanent) |
| `c` / `x` / `v` | Copy / cut / paste (a clash pastes as `name copy.ext`) |
| `o` | Open with the system's default app |
| `z` | Collapse all |
| `u` | Refresh |

Files Claude writes or edits are highlighted, and so are the folders containing them. The tree refreshes after Claude's tool calls. `.git` is hidden.

## Requirements

Claude Code with plugin UI hooks (2.1.316 or later). On Windows, file operations run through PowerShell; on macOS and Linux through `mkdir`, `mv`, `cp` and `rm`.

## Develop

```
claude --plugin-dir .          # run it from this folder; edits hot-reload
claude plugin validate .
claude plugin test .
```

## License

MIT
