# Contributing to Directory

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Bugs:** open an issue with the bug template. Your OS, terminal and `claude --version` save a round trip.
- **Features:** open an issue first, so we can agree on the shape before you write code. Directory aims to stay small and quiet; a feature earns its place by being something you reach for every session.

## Run it from source

```sh
git clone https://github.com/umarfarooque88/directory
cd directory
claude --plugin-dir .
```

Saving a file reloads the plugin in that session, so you see changes as you make them. If you also have Directory installed from the marketplace, disable that copy first with `/plugin`, or you will get two panes.

## Checks

Run both before opening a pull request. CI runs them too.

```sh
claude plugin validate .
claude plugin test .
```

Tests live in [`tests/`](tests). A change to what the pane shows or does should come with a test that fails without it.

## Code

- The plugin runs in Claude Code's own environment: no Node, no DOM. Everything outside the module goes through `$` (`$.fs`, `$.process`, `$.ui`, …).
- Keep file names out of command strings. Pass paths as arguments, or on Windows as environment variables, as [`hooks/register.tsx`](hooks/register.tsx) does.
- State the pane draws from lives in `$.state`, declared in [`types/index.d.ts`](types/index.d.ts). If you change its shape, bump the `shape` tag in `register.tsx`.
- Match the design: one accent (Claude's orange) used only for Claude's marks; everything else neutral.

## Pull requests

- One change per pull request, with a short description of what and why.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under an **Unreleased** heading.
- By contributing you agree your work is released under the [MIT License](LICENSE).
