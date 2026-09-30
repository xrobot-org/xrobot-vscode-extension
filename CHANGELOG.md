# Change Log

All notable changes to the "xrobot" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [2.0.0]

Requires XRobot 1.0 and its single `xrobot` command (including
`instance set --json ID args <list>`); the pre-1.0 commands
(`xrobot_setup`, `xrobot_gen_main`, `xrobot_add_mod`, `xrobot_src_man`, ...) are no
longer called.

### Changed

- The XRobot view is built from `xrobot describe` (schema 1): generated header state,
  installed and pinned XRobot version, `xrobot.lock` state per Module, entry source and
  `XR_REGISTER` registrations, diagnostics, the application configs (products) and the
  instances of the selected product. The extension does not parse C++ or Module
  manifests.
- The selected product is the config `User/xrobot_main.hpp` was generated for;
  selecting another product runs `xrobot gen -c <config>`. The
  `xrobot.xrobot.configPath` setting is removed; the selection is not written to
  `.vscode/settings.json`.
- Instances are added, changed, renamed and removed only with
  `xrobot instance add|set|rename|remove`. A value edit writes one node
  (`args.<param>[.<field>|[n]]...`, `template_args[n]`) as JSON (`--json`, strings
  are C++ text) with `--if-match`, so a config
  that changed after the view read it is not overwritten. After a successful edit the
  header is regenerated with `xrobot gen` when `xrobot describe` reports no error.
- Switching an instance to another constructor: the new argument list keeps the values
  of same-named parameters, gives new parameters their source default (marked in the
  preview) and is written with one `xrobot instance set --json ID args <list> --if-match`.
- Module requests are added and removed with `xrobot module add|remove`; changing a
  request's ref removes it and adds `owner/Repo@ref` (restoring the old request if the
  add fails). Refs are listed from the repository that `xrobot source get` resolves.
- Sources are added with `xrobot source add-source URL --priority N`. Changing a
  source's URL or priority and removing a source edit the entry with that URL in
  `Modules/sources.yaml`, keeping comments; the official catalog is read-only.
- Tree actions: `xrobot setup`, `setup --frozen`, `setup --update`, `gen`,
  `format --check`, `format`, `new-module`; `xrobot init` in folders without
  `Modules/modules.yaml`.
- CLIs are started without a shell after a PATH lookup (PATH, pip per-user script
  directories, `xrobot.cli.extraPath`). When a console script is missing, its Python
  module runs from the extension directory without importing Python code from the
  workspace.
- The startup check runs asynchronously and only in XRobot BSPs (`Modules/modules.yaml`
  present). It checks `git` and `xrobot`, and LibXR only when a `*.ioc` file is present.
- In untrusted workspaces the workspace values of `xrobot.cli.extraPath` and
  `xrobot.cli.pythonPath` are ignored.

### Fixed

- CLI output is decoded as UTF-8 from the complete byte stream and Python is asked to
  write UTF-8 (`PYTHONIOENCODING=utf-8`); chunk-wise decoding could split multi-byte
  characters, and on Windows with a GBK code page Chinese text was garbled.
- Commands started from the command palette without a target ask for one; `Delete Repo`
  used to remove the first request in `Modules/modules.yaml`.
- Sources were edited by their position in the priority-sorted list, which could change
  a different entry, including the official source.
- Editing one value no longer rewrites the whole YAML file.
- Exit codes of all CLI calls are checked and failures show the CLI's error message
  (`Add Source` ignored failures).
- Removing a Module request or a source asks for confirmation.
- `.vscode-dev/` and agent notes (`AGENTS.md`) are excluded from the package.

### Removed

- The LibXR Hardware Container (`device_aliases`) editor, the Module manifest editor and
  all header manifest parsing.
- `Edit Repo Name` (remove the request and add another) and `Edit Source Mirror`
  (XRobot 1.0 `sources.yaml` entries have no mirror field).
- Editing `settings` of the XRobot config from the view.

### Added

- Unit tests for the CLI adapter (argument building, UTF-8 decoding, exit codes, the
  Python fallback) using a fake `xrobot`, run with `npm test`; a GitHub Actions workflow
  that compiles, lints, tests and packages the extension without publishing it.

## [1.0.1]

- Repackage the workspace-extension and Python module fallback build.

## [1.0.0]

- Force the extension to run as a workspace extension so Remote SSH and Dev Container sessions execute XRobot/LibXR CLI commands in the remote workspace environment.
- Add the current user's standard Python/pip script directory to CLI lookup automatically, so pip-installed XRobot/LibXR commands are found without hard-coding workspace paths.
- Fall back to `python -m ...` pip package entry points when XRobot/LibXR console scripts are not on PATH.
- Treat LibXR CLI as optional during startup dependency checks, so XRobot-only workspaces do not report a failure when only the XRobot pip package is installed.

## [0.0.9]

- Fix STM32 default `xr_gen_code_stm32` action and auto-regeneration to use the workspace-root `./.config.yaml` path instead of the incorrect `User/.config.yaml`.

## [0.0.8]

- Fix repo version lookup for namespaced modules by resolving real remotes via source indexes before falling back to GitHub owner/repo guessing.
- Improve remote ref picker with branch-first ordering, inline type labels, and inline timestamps for timestamped tags.
- Add local module manifest browsing and editing from module headers, including add/delete actions and key rename for constructor/template args.
