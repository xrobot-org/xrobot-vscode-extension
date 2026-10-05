# XRobot VS Code Extension

XRobot 与 LibXR 的 VS Code 扩展 / VS Code extension for XRobot and LibXR

<h1 align="center">
<img src="https://github.com/xrobot-org/xrobot-vscode-extension/raw/master/media/xrobot.png" width="160">
</h1><br>

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/XRobot.xrobot)](https://marketplace.visualstudio.com/items?itemName=XRobot.xrobot)
[![Documentation](https://img.shields.io/badge/docs-online-brightgreen)](https://xrobot.work/)
[![GitHub Issues](https://img.shields.io/github/issues/xrobot-org/xrobot-vscode-extension)](https://github.com/xrobot-org/xrobot-vscode-extension/issues)
[![CI](https://github.com/xrobot-org/xrobot-vscode-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/xrobot-org/xrobot-vscode-extension/actions/workflows/ci.yml)

本扩展在 VS Code 的活动栏中提供 XRobot 和 LibXR 两个视图。XRobot 视图显示一个
[XRobot](https://github.com/xrobot-org/XRobot) BSP 中的模块、配置和实例，模块和实例的修改通过
`xrobot` 命令完成；LibXR 视图面向 STM32CubeMX 工程，显示 `libxr_config.yaml` 与内部 Flash 布局，并运行
[CodeGenerator](https://github.com/xrobot-org/LibXR_CppCodeGenerator) 的 `libxr` 命令。

This extension adds two views to the VS Code activity bar, XRobot and LibXR. The XRobot view
shows the Modules, configurations and instances of an [XRobot](https://github.com/xrobot-org/XRobot)
BSP and changes Modules and instances through `xrobot` commands; the LibXR view works on STM32CubeMX
projects, shows `libxr_config.yaml` and the internal Flash layout, and runs the `libxr` command of
the [CodeGenerator](https://github.com/xrobot-org/LibXR_CppCodeGenerator).

---

## 🔧 安装 / Installation

在 VS Code 的扩展市场中搜索 “XRobot” 安装，或从
[Releases](https://github.com/xrobot-org/xrobot-vscode-extension/releases) 下载 `.vsix` 文件，
通过 “从 VSIX 安装” 安装。

Install "XRobot" from the VS Code Marketplace, or download the `.vsix` file from
[Releases](https://github.com/xrobot-org/xrobot-vscode-extension/releases) and use
"Install from VSIX".

扩展调用以下命令行工具，其安装方法见各自的 README：XRobot 视图需要 xrobot 1.0（`xrobot` 命令）和
`git`，LibXR 视图需要 libxr 6.0.0（`libxr` 命令）。扩展在 `PATH`、pip 的用户脚本目录以及设置项
`xrobot.cli.extraPath` 中查找这些命令。

The extension calls these command-line tools, installed as their READMEs describe: the XRobot view
needs xrobot 1.0 (the `xrobot` command) and `git`, the LibXR view needs libxr 6.0.0 (the `libxr`
command). The commands are looked up on `PATH`, in pip's per-user script directories and in the
`xrobot.cli.extraPath` setting.

扩展 2.0.0 用于 xrobot 1.0 的 BSP。命令行工具仍是 xrobot 0.3.1 时，先将 `xrobot` 和 `libxr` 升级到上述版本
并迁移 BSP。暂时还要打开 0.x 的 BSP 时，在扩展页面的齿轮菜单中通过 “Install Specific Version...” 安装 1.0.1，
并关闭本扩展的 “Auto Update”；VS Code 默认自动更新扩展，2.0.0 发布后会替换 1.0.1。

Extension 2.0.0 works with xrobot 1.0 BSPs. If the command-line tools are still xrobot 0.3.1,
first upgrade `xrobot` and `libxr` to the versions above and migrate the BSP. To keep opening
0.x BSPs for a while, install 1.0.1 with "Install Specific Version..." in the gear menu of the
extension page and turn off "Auto Update" for this extension; VS Code updates extensions
automatically by default and would replace 1.0.1 with 2.0.0.

---

## 📚 基本概念 / Concepts

模块、配置、实例等概念与 XRobot 相同，见 [XRobot 的 README](https://github.com/xrobot-org/XRobot#-基本概念--concepts)。
打开一个文件夹后，两个视图按其内容显示：

Modules, configurations and instances are the concepts of XRobot, see the
[XRobot README](https://github.com/xrobot-org/XRobot#-基本概念--concepts). When a folder is
opened, each view shows content according to what the folder contains:

| 视图 View | 适用的文件夹 | Folder | 内容来源 | Content from |
| --- | --- | --- | --- | --- |
| XRobot | 包含 `Modules/modules.yaml` 的 BSP | A BSP with `Modules/modules.yaml` | `xrobot describe`、`Modules/modules.yaml`、`Modules/sources.yaml` | `xrobot describe`, `Modules/modules.yaml`, `Modules/sources.yaml` |
| LibXR | 根目录有 `*.ioc` 文件的 STM32CubeMX 工程 | An STM32CubeMX project with a `*.ioc` file at its root | `User/libxr_config.yaml`、`User/flash_map.hpp` | `User/libxr_config.yaml`, `User/flash_map.hpp` |

---

## 🧩 XRobot 视图 / XRobot View

XRobot 视图显示生成的主函数头文件 `User/xrobot_main.hpp` 是否过期、每个模块的 lock 状态、入口源文件中的
硬件注册和 `xrobot describe` 报告的诊断信息，并列出 `User/` 下的全部配置、所选配置中的实例及其参数、
`Modules/modules.yaml` 中的模块和 `Modules/sources.yaml` 中的源。选择另一份配置时运行
`xrobot gen -c <配置>`。

The XRobot view shows whether the generated header `User/xrobot_main.hpp` is stale, the lock state
of each Module, the registrations in the entry source and the diagnostics `xrobot describe`
reports. It lists every configuration under `User/`, the instances of the selected configuration
with their parameters, the Modules in `Modules/modules.yaml` and the sources in
`Modules/sources.yaml`. Selecting another configuration runs `xrobot gen -c <configuration>`.

实例和模块的每项修改对应一条 `xrobot` 命令。例如将 `blink_led` 的 `blink_cycle` 改为 500 时，扩展先修改
配置，再重新生成头文件：

Each change to an instance or a Module is one `xrobot` command. Changing `blink_cycle` of
`blink_led` to 500, for example, edits the configuration and then regenerates the header:

```bash
$ xrobot -C <BSP> instance -c User/xrobot.yaml set --json blink_led args.blink_cycle '"500"' --if-match <sha256>
$ xrobot -C <BSP> gen -c User/xrobot.yaml
Generated User/xrobot_main.hpp for User/xrobot.yaml
```

`--if-match` 是视图读取配置时文件内容的哈希。若文件在此之后被修改，命令保留文件原样并报告：

`--if-match` is the hash of the configuration as the view read it. If the file has changed since,
the command leaves it as it is and reports:

```text
User/xrobot.yaml changed since it was read; reload and retry
```

| 操作 Action | 命令 Command |
| --- | --- |
| 添加 / 删除实例 Add / remove an instance | `xrobot instance add MODULE [--id ID]` / `xrobot instance remove ID` |
| 修改参数值 Change a value | `xrobot instance set --json ID PATH VALUE --if-match <sha256>` |
| 切换构造函数 Switch the constructor | `xrobot instance set --json ID args LIST --if-match <sha256>` |
| 重命名实例 Rename an instance | `xrobot instance rename ID NEW_ID` |
| 添加 / 删除模块 Add / remove a Module | `xrobot module add owner/Repo[@ref]` / `xrobot module remove owner/Repo` |
| 添加源 Add a source | `xrobot source add-source URL --priority N` |
| 新建模块 Create a Module | `xrobot new-module` |
| 同步模块 Sync Modules | `xrobot setup`、`xrobot setup --frozen`、`xrobot setup --update` |
| 格式化配置 Format configurations | `xrobot format`、`xrobot format --check` |

修改源的 URL 或优先级、删除源时，扩展按 URL 修改 `Modules/sources.yaml` 中对应的条目并保留注释；
官方源只读。实例修改成功后，若所选配置没有错误，扩展运行 `xrobot gen` 重新生成头文件。

Changing a source's URL or priority and removing a source edit the entry with that URL in
`Modules/sources.yaml`, keeping comments; the official source is read-only. After an instance edit
succeeds and the selected configuration has no errors, the extension runs `xrobot gen` to
regenerate the header.

---

## 🛠 LibXR 视图 / LibXR View

LibXR 视图显示工程的平台、`User/libxr_config.yaml` 中的系统与各项设置，以及 `User/flash_map.hpp`
记录的 MCU 型号和内部 Flash 布局（按等大扇区段列出）。`libxr_config.yaml` 的值可以在视图中直接修改，
修改后运行 `libxr gen`。视图中的操作依次对应 `libxr stm32 setup`、`libxr parse`、`libxr gen` 和
`libxr stm32 flash-info`。

The LibXR view shows the project's platform, the system and settings in `User/libxr_config.yaml`,
and the MCU and internal Flash layout recorded in `User/flash_map.hpp`, listed as runs of equal
sectors. Values of `libxr_config.yaml` can be edited in the view, followed by `libxr gen`. The
view's actions are `libxr stm32 setup`, `libxr parse`, `libxr gen` and `libxr stm32 flash-info`.

### 引脚布局 / Pin Layout

LibXR 视图自上而下是：芯片（型号、封装、引脚数，展开后有 "Pin Layout"、来源文件和系统）、"Peripherals"（工程在 `.ioc`
或 SysConfig 生成的 `ti_msp_dl_config.h` 中已选的外设，按通信、定时器、模拟、存储、其他、GPIO、系统分组，GPIO 和系统
默认折叠）、Flash 布局、配置文件、操作。"Pin Layout" 打开芯片的封装图（`libxr pins`，需要带有该命令的 libxr）。每个外设显示
它的引脚，展开是它在 `libxr_config.yaml` 中的参数，可以直接修改（和 Config File 里一样，修改后重新生成代码）。点击一个
外设会打开封装图并选中它：它每个功能当前用的引脚和其他可选的引脚。

面板和侧栏联动：同一时间只选中一件事，要么一个引脚，要么一个外设。点封装图上的引脚，右侧显示这个引脚、项目里用作什么、
它还能是什么；点其中的外设名（或侧栏 Peripherals 里的一项），右侧改显示这个外设：设置，以及它每个功能的引脚，封装图上
当前用的引脚为实线、其他候选为虚线，点引脚名在封装图上定位。在面板里选中外设（或点一个已选的引脚），侧栏里对应的外设
也被选中。

封装图：滚轮以光标为中心缩放（窗口窄、图在检查器上方时，滚轮滚动页面，Ctrl+滚轮缩放），按住拖动平移，双击回到完整视图（像 CubeMX）。已选的引脚按外设类别着色，标签是引脚名加上所选功能（`PA9 USART1.TX`）或 GPIO 的标签（`PC0 ACC_CS`）；
左上角的圆点是 1 脚。搜索框按引脚名、信号或外设（如 `usart1 tx`）高亮匹配的引脚，图例可以按类别过滤。点击引脚
显示它能承载的外设功能（按类别折叠），点击其中的外设名选中该外设。图中列出所有识别出的外设，包括 LibXR 没有对应
抽象的（ETH、FMC、OctoSPI 等）。MSPM0 的封装用设置 `xrobot.libxr.package` 给出。目前只读；MSPM0 只有引脚布局，
LibXR 代码生成仅支持 STM32。

The LibXR view reads, top to bottom: the chip (part, package and pins; open it for Pin Layout, the source file and the
system), Peripherals (what the project selected in its `.ioc` or in the `ti_msp_dl_config.h` SysConfig generates, by
category: communication, timers, analog, memory, other, GPIO, system, with GPIO and system closed), the Flash layout, the
config file and the actions. Pin Layout opens the package drawing of the chip (`libxr pins`, which needs a libxr release
that has the command). Each peripheral shows its pins; open it for its settings in `libxr_config.yaml`, which can be edited
there (as in the Config File, the code is regenerated). Clicking a peripheral opens the drawing with it selected: the pin each
of its functions uses and the other pins that can carry it.

The panel and the sidebar follow each other, and one thing is selected at a time: a pin or a peripheral. Click a pin on the
drawing and the inspector shows the pin, what the project uses it as and what else it can be; click a peripheral name there
(or an item of the Peripherals group in the sidebar) and the inspector shows the peripheral: its settings and the pins of each
function, drawn solid for the pin in use and dashed for the other candidates; click a pin name to find it on the drawing.
Selecting a peripheral in the panel (or clicking a pin the project uses) selects it in the sidebar too.

The wheel zooms around the pointer, a drag pans and a double click shows the whole package again, as in CubeMX (in a narrow
window, where the drawing sits above the inspector, the wheel scrolls the page and Ctrl+wheel zooms). The search box
highlights matching pins; Enter goes to the next match, Shift+Enter to the previous, Escape clears. The arrow keys walk along the
package once a pin is selected, and Escape clears the selection.

In the drawing the selected pins are coloured by peripheral category and labelled with the pin name and the selected
function (`PA9 USART1.TX`) or the label of a GPIO (`PC0 ACC_CS`); the dot in the top-left corner marks pin 1. The search
box highlights the pins that match a pin name, signal or peripheral (such as `usart1 tx`), and the legend filters by
category. Clicking a pin shows the peripheral functions it can carry, folded by category; clicking a peripheral name selects
it. Every recognized peripheral is listed, including those LibXR has no abstraction for (ETH, FMC, OctoSPI, ...). Give the
package of an MSPM0 with the `xrobot.libxr.package` setting. The panel is read-only for now; an MSPM0 has the pin layout
only, and LibXR code generation is STM32 only.

---

## 🚀 命令一览 / Commands

以下命令可在命令面板中运行，也出现在视图的右键菜单和标题栏中。

These commands run from the Command Palette and also appear in the views' context menus and title
bars.

| 命令 Command | 作用 Purpose |
| --- | --- |
| XRobot: Refresh All | 重新读取两个视图 / Reload both views |
| XRobot: Collapse All Views | 折叠两个视图 / Collapse both views |
| XRobot: Show Pin Layout | 打开封装图 / Open the package drawing |
| XRobot: Select Product (xrobot gen -c) | 选择配置并生成头文件 / Select a configuration and generate the header |
| XRobot: Add Module Instance | 添加实例 / Add an instance |
| XRobot: Edit Module Instance | 修改实例 / Edit an instance |
| XRobot: Delete Module Instance | 删除实例 / Delete an instance |
| XRobot: Create Module (xrobot new-module) | 新建模块 / Create a Module |
| XRobot: Add Module Request | 添加模块 / Add a Module |
| XRobot: Change Module Request Ref | 修改模块的 ref / Change a Module's ref |
| XRobot: Remove Module Request | 删除模块 / Remove a Module |
| XRobot: Add Source | 添加源 / Add a source |
| XRobot: Edit Source URL | 修改源的 URL / Change a source's URL |
| XRobot: Edit Source Priority | 修改源的优先级 / Change a source's priority |
| XRobot: Delete Source | 删除源 / Delete a source |
| XRobot: Pick LibXR Config Path | 选择 `libxr_config.yaml` / Pick `libxr_config.yaml` |
| XRobot: Pick LibXR App Main Path | 选择 `app_main.cpp` / Pick `app_main.cpp` |

---

## ⚙️ 设置 / Settings

| 设置 Setting | 作用 Purpose |
| --- | --- |
| `xrobot.cli.extraPath` | 查找命令行工具时追加的目录（PATH 语法）/ Extra directories for finding the CLIs (PATH syntax) |
| `xrobot.cli.pythonPath` | 找不到命令时用于运行对应 Python 模块的解释器 / Interpreter that runs the Python module when a command is not found |
| `xrobot.libxr.iocFile` | 使用的 `.ioc` 文件，留空时取根目录下的第一个 / The `.ioc` file to use; empty takes the first one at the root |
| `xrobot.libxr.package` | 芯片封装，用于型号中没有封装的工程（MSPM0：`LQFP-64`、`PM` 等）/ Package of the chip for a project whose model does not name it (MSPM0: `LQFP-64`, `PM`, ...) |
| `xrobot.libxr.configPath` | `libxr_config.yaml` 的路径 / Path of `libxr_config.yaml` |
| `xrobot.libxr.appMainPath` | `app_main.cpp` 的路径 / Path of `app_main.cpp` |

---

## 🧪 测试 / Tests

```bash
$ npm ci
$ npm run compile
$ npm test
  48 passing (2s)
  1 pending
```

`npm test` 运行单元测试，`npm run test:vscode` 在 VS Code 扩展宿主中运行测试，`npm run package` 打包
`.vsix`。CI 在 Linux 和 Windows 上编译、检查、测试并打包。

`npm test` runs the unit tests, `npm run test:vscode` runs the tests in the VS Code extension host,
and `npm run package` builds the `.vsix`. CI compiles, lints, tests and packages on Linux and
Windows.

---

## 📖 更多信息 / More Information

- [XRobot](https://github.com/xrobot-org/XRobot)：模块管理与主函数生成 / Module management and main function generation
- [LibXR_CppCodeGenerator](https://github.com/xrobot-org/LibXR_CppCodeGenerator)：`libxr` 命令 / The `libxr` command
- [文档 / Documentation](https://xrobot.work/)
- [更新记录 / Changelog](CHANGELOG.md)
- [问题反馈 / Issues](https://github.com/xrobot-org/xrobot-vscode-extension/issues)
