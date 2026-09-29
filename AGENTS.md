# XRobot VS Code Extension Agent Notes

## Goal
A VS Code sidebar for XRobot 1.0 BSPs and the LibXR STM32 generator:
- Activity Bar container `xrobot`, tree views `xrobot.libxrView` and `xrobot.xrobotView`.
- The XRobot view is a UI over the `xrobot` CLI (`describe`, `instance`, `gen`, `setup`, `format`,
  `module`, `source`, `new-module`, `init`). It never parses C++ or Module manifests.

## Architecture
- Entry: `src/extension.ts` -> `src/xrobotExtension.ts` (views, debounced refresh, async startup check).
- CLI adapter, no `vscode` import (unit-tested with a fake `xrobot`):
  - `src/cli/process.ts`: PATH lookup (`.exe`/`.com` only on Windows), shell-free spawn, UTF-8 decoding
    of the whole byte buffer, CLI error message (last non-warning stderr line).
  - `src/cli/xrobotCli.ts`: argument builders (`-C <abs root>`, absolute paths), `instance set` value
    paths, `--if-match` hash (sha256, CRLF->LF), environment (pip user script dirs, extraPath,
    `PYTHONIOENCODING=utf-8`), Python-module fallback (runs from the extension dir, drops `''` from
    `sys.path`, then chdirs into the workspace).
- `src/cliHost.ts`: settings, `XRobot` output channel, shared `xrobot describe` result (one run per
  refresh, cancelled when superseded; config hashes taken before describe runs).
- `src/providers/describeModel.ts`: describe schema 1 types and pure helpers.
- `src/providers/instanceEditor.ts`: quick-pick editor; returns one `set` (single node) or `rename`.
- `src/providers/workspaceFiles.ts`: reads `Modules/modules.yaml` / `Modules/sources.yaml`; source
  URL/priority edits and removal by URL through the YAML document model.
- `src/providers/viewProviders.ts`: both trees, LibXR helpers, watchers.
- `src/commands/xrobotCommands.ts`, `src/commands/commandHandlers.ts`: commands.

## Rules
- Keep `xrobot.helloWorld`; keep `engines.vscode` compatible with 1.108; dev host launches with
  `--disable-extensions` and `.vscode-dev/` profile dirs (never packaged, never committed).
- Selected product = describe `selected` (the config the header was generated for). Never write it to
  `.vscode/settings.json`; switching = `xrobot gen -c <config>`.
- Config edits only via `xrobot instance add|set|rename|remove`; `set` writes one node with
  `--if-match`. Constructor switch (D8): `set ID args <list>`, same-named values kept, new
  parameters from describe defaults and marked in the preview. Never write a value the user did not enter; cancel writes nothing.
- Commands invoked without a target ask for it (or do nothing). Deletes ask for confirmation.
- Sources: identity is the URL; the official catalog (`https://xrobot.work/xrobot-modules/index.yaml`)
  is read-only.
- Check every CLI exit code and show the CLI's stderr message; suggest commands only as the CLI or
  describe diagnostics do.
- Never `shell: true`; never run workspace Python code.
- Startup check: asynchronous, only when `Modules/modules.yaml` exists.
- Tests: `npm test` (mocha, `out/test/unit`), `npm run test:vscode` (extension host, `out/test/suite`).
