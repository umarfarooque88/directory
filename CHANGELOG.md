# Changelog

All notable changes to Directory. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-11-01

### Added
- **This session**: a list above the tree of the files Claude read, created and edited, newest first, with how long ago. Enter on an entry reveals it in the tree.
- A right-hand gutter that marks files Claude changed with `◆`, and their folders with a dim `◆`.
- <kbd>m</kbd> shows or hides the second row of keys.

### Changed
- Quieter tree: no per-type colors, plain `│` indent guides, the project name as the header.
- Dialogs use a neutral frame; only delete is red.
- A cut item shows `✂` in the gutter instead of italics.

## [0.2.0] — 2026-11-01

### Changed
- Renamed from **file-explorer** to **Directory**. The command is now `/directory`, and the plugin installs as `directory`.
- First visual pass: tree guides, file-type colors, framed dialogs and a status line.

## [0.1.0] — 2026-11-01

### Added
- A file tree pane docked beside the Claude Code chat.
- New file, new folder, rename, delete (to the Recycle Bin on Windows), copy, cut, paste and open with the default app.
- Enter on a file inserts `@path` into the prompt.
- Highlighting of files Claude writes or edits, and a refresh after Claude's tool calls.

[0.3.0]: https://github.com/umarfarooque88/directory/releases/tag/v0.3.0
[0.2.0]: https://github.com/umarfarooque88/directory/compare/781e5ad...04738fc
[0.1.0]: https://github.com/umarfarooque88/directory/commit/781e5ad
