# Change Log

## [Unreleased]

### Added

- `XRobot: Show Pin Layout` (also the Pin Layout item and the title bar button of the LibXR
  view): a panel with the package and pin layout of the project's chip from `libxr pins -d`.
  The pins the project selected are coloured by peripheral category and labelled with the
  pin name and the function (`PA9 USART1.TX`) or the GPIO label; the top-left dot marks pin
  1. The search box and the legend highlight and filter pins; clicking a pin lists the
  peripheral functions it can carry, and selecting a peripheral shows every pin that can
  carry each of its functions. Read-only. Needs a libxr release that has `libxr pins`.
- The panel is the chip: the drawing fills the window, the name and package are written on the
  chip, the controls (Search, Functions, Legend, Details) and the zoom float over it, and the
  inspector opens beside it when something is selected. The legend is a panel opened by its
  button and the inspector's blocks fold; what is open is remembered.
- The panel zooms with the wheel around the pointer, pans with a drag and fits with a double
  click. The inspector shows one selection at a time, a pin or a peripheral, in plain
  sections (what the project uses it as, what else it can be, its settings and pins).
  Selecting a peripheral in the panel selects it in the Peripherals group, and the other
  way round.
- The LibXR view starts with the chip (part, package, pins; Pin Layout, the source file and the
  system below it), and the Peripherals group sorts what the project selected by category, with
  coloured icons, a tooltip with the pins, and the settings as children that can be edited like
  the Config File. GPIO and system start closed.
- The panel: a zoom percentage, a search that Enter steps through, a Show functions toggle,
  a legend that filters by category (shown with a project only), keyboard navigation, a loading
  and an updating indicator, an error box with the CLI message and a link to the output, and the
  zoom, search and selection kept when the panel is hidden. Selecting a peripheral in the sidebar
  zooms to its pins.
- The LibXR view has a Peripherals group: the peripherals the project selected, with their
  pins and their settings in `libxr_config.yaml`; clicking one selects it in the panel. The
  panel and the group share one `libxr pins` run per refresh.
- The settings of an MSPM0 peripheral (baud rate, interrupts, ...) are read from the `.syscfg` and
  shown read-only in the panel and under the peripheral in the Peripherals group, next to its
  `libxr_config.yaml` settings.
- MSPM0 projects (a SysConfig `.syscfg` in the root) and HPM projects (an `app.yaml` with
  `boards/*/*.hpmpc`) are recognized: the LibXR view shows the platform and the pin layout. The
  MSPM0 package comes from the SysConfig project; the setting `xrobot.libxr.package` only
  overrides it.
- Generate LibXR Code (`libxr parse`, then `libxr gen`) for STM32, MSPM0 and HPM, and the setup
  of a project without `libxr_config.yaml` (`libxr stm32|mspm0|hpm setup`, with `--xrobot` or
  `--no-xrobot` by whether the workspace is an XRobot BSP). The settings of the peripherals in
  `libxr_config.yaml` can be edited for every platform, including the pin renames of an HPM
  project before its `GPIO` section exists.
- Open in SysConfig starts the standalone SysConfig on the `.syscfg` of an MSPM0 project; Open in
  HPM Pinmux Tool opens the `.hpmpc` with HPMicro's extension or offers to install it.
- Settings `xrobot.libxr.sysconfigTool` and `xrobot.libxr.mspm0SdkDir` (the `SYSCONFIG_TOOL` and
  `MSPM0_SDK_INSTALL_DIR` of an MSPM0 parse); ignored from an untrusted workspace.

### Changed

- The LibXR view no longer says "Unsupported platform" for a workspace without an `.ioc`; it
  says what it recognizes.

## [2.0.0] - 2026-10-04

Requires xrobot 1.0 and its single `xrobot` command (including
`instance set --json ID args <list>`); the pre-1.0 commands
(`xrobot_setup`, `xrobot_gen_main`, `xrobot_add_mod`, `xrobot_src_man`, ...) are no
longer called. The LibXR view requires libxr 6.0.0 and its single `libxr` command
(`libxr parse`, `libxr gen`, `libxr stm32 setup`, `libxr stm32 flash-info`) instead of
the `xr_*` commands.

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
- The Create Module wizard passes each dependency with its own `--depends` and, for a
  Module with template parameters, asks for the template arguments the Module CI
  compiles with (`--template-arg`).
- The CLIs run with `XR_LANG` set from the VS Code display language (unless the user set
  it), so their messages are Chinese in a Chinese VS Code and English otherwise; a
  failure message skips warning lines in either language.
- CLIs are started without a shell after a PATH lookup (PATH, pip per-user script
  directories, `xrobot.cli.extraPath`). When a console script is missing, its Python
  module runs from the extension directory without importing Python code from the
  workspace.
- The startup check runs asynchronously and only in XRobot BSPs (`Modules/modules.yaml`
  present). It checks `git` and `xrobot`, and LibXR only when a `*.ioc` file is present.
- In untrusted workspaces the workspace values of `xrobot.cli.extraPath` and
  `xrobot.cli.pythonPath` are ignored.
- The LibXR view reads the Flash layout (MCU and runs of equal sectors) from
  `flash_map.hpp` next to `app_main.cpp`, as libxr 6.0.0 no longer writes a
  `FlashLayout` section to `libxr_config.yaml`; `libxr stm32 flash-info` uses that MCU.

### Fixed

- CLI output is decoded as UTF-8 from the complete byte stream and Python is asked to
  write UTF-8 (`PYTHONIOENCODING=utf-8`); chunk-wise decoding could split multi-byte
  characters, and on Windows with a GBK code page Chinese text was garbled.
- Commands started from the command palette without a target ask for one; `Delete Repo`
  used to remove the first request in `Modules/modules.yaml`.
- After a value in `libxr_config.yaml` is edited in the LibXR view, `libxr parse` runs
  before `libxr gen`; gen read `.config.yaml`, which Git ignores, and failed in a fresh
  clone.
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
  (xrobot 1.0 `sources.yaml` entries have no mirror field).
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
