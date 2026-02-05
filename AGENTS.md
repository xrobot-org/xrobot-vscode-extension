# XRobot VS Code Extension Agent Notes

Last Updated: 2026-02-05

## Goal
Provide a lightweight VS Code sidebar experience for XRobot + LibXR with:
- Activity Bar container `xrobot`
- Tree views `xrobot.libxrView` and `xrobot.xrobotView`
- CLI actions + YAML-backed workspace management

## Current Architecture
- Entry point: `src/extension.ts`
- Extension bootstrap: `src/xrobotExtension.ts`
- Providers layer: `src/providers/viewProviders.ts`
- Commands layer: `src/commands/commandHandlers.ts`
- YAML layer: `src/yaml/yamlStore.ts`
- UI semantic labels: `src/uiText.ts`

## Key Product Rules
- Keep `xrobot.helloWorld` command intact.
- Keep `engines.vscode` compatible with VS Code 1.108.x.
- Dev host launch should include `--disable-extensions`.
- Prefer semantic text over ambiguous placeholders.
  - Mirror missing => `not a mirror source`
  - Repo version missing => `default branch latest`

## High-Risk Areas
- YAML write-back paths:
  - `Modules/modules.yaml`
  - `Modules/sources.yaml`
  - selected LibXR config file under `User/**`
- Protected source URL should not be editable/deletable:
  - `https://xrobot-org.github.io/xrobot-modules/index.yaml`
- Alias editing in hardware container must keep at least one alias.

## Change Protocol (Keep This Updated)
When changing behavior or file structure, update this file in the same commit:
1. Update `Last Updated`.
2. Update `Current Architecture` if files/responsibilities changed.
3. Update `Key Product Rules` if UX semantics/constraints changed.
4. Add any new high-risk behavior to `High-Risk Areas`.
