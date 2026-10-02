# XRobot VS Code Extension

VS Code views for XRobot BSPs (XRobot 1.0) and the LibXR STM32 code generator.
The extension is a user interface over the `xrobot` CLI: it shows what
`xrobot describe` reports and makes every change through an `xrobot` command.
It does not parse C++ sources or Module manifests itself.

## Requirements

- XRobot 1.0: `pip install xrobot` (provides the `xrobot` command).
- `git` (used by `xrobot setup` and by the ref picker).
- Optional, for the LibXR view: `pip install libxr`.

A folder is treated as an XRobot BSP when it contains `Modules/modules.yaml`
(the CLI's own rule). Elsewhere the XRobot view only offers `xrobot init`.

## XRobot view

- **Status**: the generated header `User/xrobot_main.hpp` (fresh, stale with any
  missing inputs, missing), the installed and pinned XRobot version, the
  `xrobot.lock` state per Module, the entry source and its `XR_REGISTER`
  registrations, and every diagnostic `xrobot describe` reports.
- **Products**: all application configs under `User/`. The selected product is the
  config the generated header was made for; selecting another one runs
  `xrobot gen -c <config>`. Nothing is written to `.vscode/settings.json`.
- **Instances** of the selected product: Module, id, template arguments and
  constructor arguments. Values not filled in (`null`) are marked; dependency
  parameters offer the registrations, earlier instances and constants that bind to
  them. Struct values are shown field by field; aggregate and class parameters can
  be built from their fields or constructors.
- **Modules**: the requests in `Modules/modules.yaml` with their lock state.
- **Sources**: the catalogs in `Modules/sources.yaml`, by priority. The official
  catalog is read-only.
- **Actions**: `xrobot setup`, `setup --frozen`, `setup --update`, `gen`,
  `format --check`, `format`, and `xrobot new-module`.

### How changes are made

| Change | Command |
| --- | --- |
| add / remove an instance | `xrobot instance -c <config> add MODULE [--id ID]` / `remove ID` |
| change one value | `xrobot instance -c <config> set --json ID PATH JSON --if-match <sha256>` |
| switch an instance to another constructor | `xrobot instance -c <config> set --json ID args '<JSON list>' --if-match <sha256>` |
| rename an instance (and its references) | `xrobot instance -c <config> rename ID NEW_ID` |
| select the product | `xrobot gen -c <config>` |
| add / remove a Module request | `xrobot module add owner/Repo[@ref]` / `module remove owner/Repo` |
| change a request's ref | `xrobot module remove` then `xrobot module add owner/Repo@ref` (the old request is added back if the add fails; the request moves to the end of the list) |
| add a source | `xrobot source --sources Modules/sources.yaml add-source URL --priority N` |
| change a source's URL or priority, remove a source | edited in `Modules/sources.yaml` by URL, keeping comments (the CLI has no command for it); never the official catalog |

- Each value edit writes a single node (`args.<param>`, `args.<param>.<field>`,
  `[n]`, `template_args[n]`). `--if-match` carries the hash of the config as it
  was when the view read it; if the file changed since, the CLI refuses and the
  view reloads.
- Constructor switch: pick another constructor of the Module (from `xrobot
  describe`); the preview keeps every value whose parameter name also exists in the
  new constructor, gives new parameters their source default (`null`, "not filled
  in", when there is none) and marks them NEW; dropped arguments are listed. Apply
  writes the whole list with one `instance set ID args`.
- Cancelling a prompt writes nothing; an unchanged value is not written; an empty
  C++ expression cannot be submitted.
- Commands started from the command palette ask for their target; deleting
  instances, requests and sources asks for confirmation.
- After a successful instance edit the view reloads and, when `xrobot describe`
  reports no error for the selected product and the header is not fresh, runs
  `xrobot gen` for it.
- CLI errors are shown with the message the CLI printed (it exits with code 1 and
  writes the reason to stderr).

### Not provided

- Editing `settings` (e.g. `monitor_sleep_ms`): not covered by `xrobot instance`;
  edit the config file.

## How the CLIs are run

- Without a shell: every argument (paths with spaces, JSON, C++ text) reaches the
  program as one argument.
- `xrobot` and the LibXR scripts are looked up on `PATH`, plus the pip per-user
  script directories and `xrobot.cli.extraPath`. If a script is not found, its
  Python module is run with `xrobot.cli.pythonPath` (or `python`/`python3`/`py`
  from `PATH`). That process starts in the extension's directory and drops the
  working directory from `sys.path` before changing into the workspace, so no
  Python code from the workspace is imported; `xrobot` always receives the BSP as
  `-C <absolute path>` and absolute file paths.
- Output is decoded as UTF-8 from the complete byte stream, and the processes get
  `PYTHONIOENCODING=utf-8` so that Python writes UTF-8 on every platform (including
  Windows with a GBK console code page).
- On activation in an XRobot BSP the extension checks, asynchronously, that `git`
  and `xrobot` can be started and reports problems in the `XRobot` output channel.
- In an untrusted workspace, workspace values of `xrobot.cli.extraPath` and
  `xrobot.cli.pythonPath` are ignored.
- With Remote SSH / Dev Containers the extension runs on the remote side
  (`extensionKind: workspace`), where the BSP and the CLIs are.

## LibXR view

STM32 projects (a `*.ioc` in the workspace root): `libxr stm32 setup`, `libxr parse`,
`libxr gen`, `libxr stm32 flash-info`, the flash layout, and editing of
`User/libxr_config.yaml` values (followed by `libxr gen`). The actions need libxr 6.0.0 or
later, which has the single `libxr` command.

## Settings

- `xrobot.cli.extraPath`: extra directories for the CLI lookup (PATH syntax).
- `xrobot.cli.pythonPath`: interpreter for the Python-module fallback.
- `xrobot.libxr.iocFile`, `xrobot.libxr.configPath`, `xrobot.libxr.appMainPath`:
  LibXR view paths.

## Development

```bash
npm ci
npm run compile
npm run lint
npm test             # unit tests (Node + mocha), including the CLI adapter with a fake xrobot
npm run test:vscode  # extension-host tests (uses a local VS Code or downloads one)
npm run package      # builds the .vsix with vsce
```

CI (`.github/workflows/ci.yml`) runs compile, lint, the unit tests and packaging on
Linux and Windows; it does not publish.
