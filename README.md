# XRobot VS Code Extension

VS Code extension for XRobot + LibXR workspace management.

## Features

- Activity Bar container `XRobot` with two views: `LibXR` and `XRobot`
- Tree-based configuration browsing and editing (YAML-backed)
- XRobot view driven by `xrobot_describe`: lock status per Module, entry-header (`User/xrobot_main.hpp`)
  stamp freshness, generation diagnostics, settings and instances of the current application config
- Instance add/edit/delete through `xrobot_instance`, with an argument editor that offers registered names
  (`XR_REGISTER`) and instance ids as candidates and edits struct/class parameters field by field
- One-click CLI actions for common XRobot/LibXR workflows (`xrobot_setup --frozen`, `xrobot_setup --update`,
  `xrobot_gen_main`, CubeMX/STM32 generation)
- Auto-refresh on workspace YAML/IOC/lock changes
- Auto-regeneration (`xrobot_gen_main` / `xr_gen_code_stm32`) after config edits

## Requirements

- `git`
- `python` (or `py`) + `pip` (configurable via `xrobot.cli.pythonPath`)
- pip packages:
  - `xrobot` (0.3.1 or newer: provides `xrobot_describe` and `xrobot_instance`)
  - `libxr`
  - Alternatively: install CLIs via `pipx` and ensure they are on PATH.

The extension checks dependencies at startup and reports missing items in the `XRobot` output channel.

## Settings

- `xrobot.cli.extraPath`
- `xrobot.cli.pythonPath`
- `xrobot.libxr.iocFile`
- `xrobot.libxr.configPath`
- `xrobot.libxr.appMainPath`
- `xrobot.xrobot.configPath`

## Development

```bash
npm install
npm run compile
```
