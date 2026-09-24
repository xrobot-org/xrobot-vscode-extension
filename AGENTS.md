# XRobot VS Code Extension Agent Notes

## Goal
Provide a lightweight VS Code sidebar experience for XRobot + LibXR with:
- Activity Bar container `xrobot`
- Tree views `xrobot.libxrView` and `xrobot.xrobotView`
- CLI actions + YAML-backed workspace management

## Current Architecture
- Entry point: `src/extension.ts`
- Extension bootstrap: `src/xrobotExtension.ts`
- Providers layer: `src/providers/viewProviders.ts`
- `xrobot_describe` model + CLI argument builders (pure, unit-tested): `src/providers/describeModel.ts`
- Instance argument editor (quick picks driven by describe data): `src/providers/instanceEditor.ts`
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
- The extension never parses C++ headers or module manifests. Everything about Modules (constructors, template
  parameters, mapping shapes, bindable names), the lock, the entry-header stamp and diagnostics comes from
  `xrobot_describe -C <root> -c <config> -o User/xrobot_main.hpp --register-source <app main> --lock xrobot.lock`
  (JSON schema 1). Its result is cached per refresh and shared by the tree and the edit commands; every edit
  and watched file change refreshes it.
- XRobot config format: `modules: [{module, id, template_args?, args?}]`, `settings: {monitor_sleep_ms}`
  (plus optional `constexprs`/`constexpr_namespace`/`constexpr_includes`). Values are C++ expression text or
  YAML mappings/lists for structs.
- Instances are edited only through `xrobot_instance -c <config> add|set|remove` (it validates and keeps YAML
  comments); never write instances directly. `set` takes one JSON argv element with `id`, `template_args`
  and/or the whole `args` list.
  - Argument editor: parameters come from the constructor whose names match the instance's args (else the
    user picks a constructor, which resets args to its defaults); `candidates` => quick pick + "C++ expression…";
    `default_fields`/`type_ref` => structured editor whose mapping lists exactly the required keys in order
    (aggregate fields, or one class constructor's parameter names); otherwise C++ text input.
- CLI processes are spawned without a shell with argument arrays (JSON/C++ text stay one argv element). If an
  xrobot console script is missing from PATH, its Python entry point is run with the detected interpreter.
- Current Workspace UI uses one merged `Current Config: <path>` section containing editable `settings` and instances;
  a `Status` group shows lock status (per-module commit/status), entry-header stamp status and diagnostics.
- Auto-regenerate behavior:
  - Editing LibXR config triggers `xr_gen_code_stm32` with current configured paths.
  - Editing XRobot config/instances triggers `xrobot_gen_main -c <config> -o User/xrobot_main.hpp --register-source <app main> --lock xrobot.lock`.
  - Switching current LibXR/XRobot config triggers its corresponding code generation.
- XRobot actions: `xrobot_setup --frozen` (resolve locked sources), `xrobot_setup --update` (update lock),
  `xrobot_gen_main` (regenerate entry), all with the current config and register source.
- Add repo should prefer candidates discovered from current sources via `xrobot_src_man list`.
- Startup diagnostics must check `git`, `python`, `pip`, and pip packages `xrobot`/`libxr`, and report missing dependencies in the `XRobot` output channel.
- CLI command labels and invocations must avoid `.exe` suffixes to keep Linux/macOS compatibility.
- LibXR view gating:
  - unsupported platform => show unsupported only
  - STM32 but missing libxr yaml => show platform + `xr_cubemx_cfg -d .` action only
  - STM32 + libxr yaml present => show full LibXR panels/actions
- XRobot view gating:
  - missing current xrobot yaml => show only `xrobot_setup` action
  - current xrobot yaml exists but is not xrobot-shaped (must contain `modules` array or `settings` object) => treat as missing
- UX ordering rule: in each peer list/group, place `add ...` operations before existing items for faster access in long lists.

## High-Risk Areas
- YAML write-back paths:
  - `Modules/modules.yaml`
  - `Modules/sources.yaml`
  - selected LibXR config file under `User/**`
  - `settings.*` scalars of the current XRobot config (document-model edit, comments preserved)
- Protected source URL should not be editable/deletable:
  - `https://xrobot.work/xrobot-modules/index.yaml`
- `xrobot_describe` takes ~10-20 s on a full BSP: keep it lazy (root `getChildren` only), cancel superseded runs.
