# Change Log

All notable changes to the "xrobot" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Migrate to the static-assembly XRobot toolchain (config `modules: [{module, id, template_args, args}]` + `settings`).
- XRobot view is now driven by `xrobot_describe`: new Status group (lock status per Module, entry-header stamp state with the changed input, diagnostics), settings and instances read from its JSON.
- Instances are added, edited and removed only through `xrobot_instance add|set|remove`; the new argument editor picks the constructor matching the current args, offers `XR_REGISTER` names / instance ids as candidates and edits struct parameters field by field (aggregates) or by constructor (classes).
- New actions: `xrobot_setup --frozen`, `xrobot_setup --update`, and `xrobot_gen_main -c <config> -o <header> --register-source <src> --lock <lock>` (also used for auto-regeneration).
- Remove the LibXR Hardware Container / `device_aliases` editor and its commands (aliases no longer exist in the toolchain).
- Remove the module-manifest interface editor and all header manifest parsing; interfaces come from `xrobot_describe`.
- An XRobot config is recognised by a `modules` list or a `settings` mapping.
- CLIs run without a shell (arguments passed as an array); missing xrobot console scripts fall back to their Python entry point.
- `Create Module` passes C++ constructor/template declarations to `xrobot_create_mod` (hardware tags removed).
- YAML scalar edits keep comments and layout of the rest of the file.

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
