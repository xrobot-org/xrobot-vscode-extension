# XRobot VS Code Extension Agent Notes

Last Updated: 2026-02-06

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
- Allow configuring Python executable via `xrobot.cli.pythonPath` (name or full path).
- Dependency checks should accept pipx-installed CLIs (CLI in PATH is sufficient even if `pip show` fails).
- Prefer semantic text over ambiguous placeholders.
  - Mirror missing => `not a mirror source`
  - Repo version missing => `default branch latest`
- For XRobot module/source operations, prefer pip CLI commands whenever possible:
  - add repo: `xrobot_add_mod ...`
  - add source: `xrobot_src_man add-source ...`
  - use direct YAML write only when no equivalent CLI subcommand exists (edit/delete fallback)
- Actions should avoid duplicating GUI edit capabilities.
- Tree views default to collapsed at startup; support one-click collapse-all.
- LibXR actions prioritize STM32 flow (`*.ioc` detected) and avoid requiring `config.yaml` in workspace.
- Current Workspace supports editing selected `xrobot` config values (e.g. `global_settings.monitor_sleep_ms`) and module instance add/edit/delete.
  - Add instance should prefer pip CLI (`xrobot_add_mod <ModuleName> --config <current config>`).
- Current Workspace UI uses one merged `Current Config: <path>` section containing editable global settings and instances.
- Auto-regenerate behavior:
  - Editing LibXR config or hardware aliases triggers `xr_gen_code_stm32` with current configured paths.
  - Editing XRobot config/instances triggers `xrobot_gen_main --config <current xrobot config>`.
- Add repo should prefer candidates discovered from current sources via `xrobot_src_man list`.
- Startup diagnostics must check `git`, `python`, `pip`, and pip packages `xrobot`/`libxr`, and report missing dependencies in the `XRobot` output channel.
- LibXR view gating:
  - unsupported platform => show unsupported only
  - STM32 but missing libxr yaml => show platform + `xr_cubemx_cfg.exe -d .` action only
  - STM32 + libxr yaml present => show full LibXR panels/actions
- XRobot view gating:
  - missing current xrobot yaml => show only `xrobot_setup` action
- UX ordering rule: in each peer list/group, place `add ...` operations before existing items for faster access in long lists.

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
