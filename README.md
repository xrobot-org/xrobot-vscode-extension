# XRobot VS Code Extension

VS Code extension for XRobot + LibXR workspace management.

## Features

- Activity Bar container `XRobot` with two views: `LibXR` and `XRobot`
- Tree-based configuration browsing and editing (YAML-backed)
- One-click CLI actions for common XRobot/LibXR workflows
- Auto-refresh on workspace YAML/IOC changes
- Optional auto-generation hooks after config edits

## Requirements

- `git`
- `python` (or `py`) configured via `xrobot.cli.pythonPath`; `pip` is only needed to install packages
- pip packages:
  - `xrobot`
  - `libxr` only for STM32/LibXR actions
  - Alternatively: install CLIs via `pipx` and ensure they are on PATH.

The extension checks dependencies at startup and reports missing items in the `XRobot` output channel.
If console scripts are not on PATH, it falls back to `python -m ...` entry points from the installed pip packages.

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
