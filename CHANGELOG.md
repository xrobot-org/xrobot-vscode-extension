# Change Log

All notable changes to the "xrobot" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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
