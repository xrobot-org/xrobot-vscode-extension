// The LibXR view's per-platform decisions, without the VS Code API: the labels of a platform,
// the setup and CLI actions of the sidebar and the files the watchers follow. Pure.
import type { CliRunRequest } from './providers/viewProviders';

export type LibxrPlatform = 'stm32' | 'mspm0' | 'hpm' | 'unknown';

// The platform in one word: the chip group's title while `libxr pins` has no result.
// What the views say when the workspace root holds no project of a supported platform.
export const NO_PROJECT_MESSAGE =
	'No platform recognized: the workspace root needs an STM32CubeMX .ioc, an app.yaml with a .hpmpc under boards/, or a SysConfig .syscfg.';

export function platformTitle(platform: LibxrPlatform): string {
	return platform === 'unknown' ? 'Project' : platform.toUpperCase();
}

// The tool the chip source file came from (.ioc, .syscfg or .hpmpc).
export function sourceToolLabel(platform: LibxrPlatform): string {
	switch (platform) {
		case 'stm32':
			return 'STM32CubeMX';
		case 'mspm0':
			return 'SysConfig';
		case 'hpm':
			return 'HPM Pinmux Tool';
		default:
			return 'Project';
	}
}

// The one-step setup of each platform: the sidebar's action while there is no libxr_config.yaml
// (for STM32 also among the actions of a configured project). `libxr hpm setup` and
// `libxr mspm0 setup` parse the project and generate User/app_main.cpp; with neither flag they
// generate XRobot registrations, so the choice is always passed: a project without XRobot would
// otherwise get an app_main.cpp that includes xrobot_main.hpp.
export function setupAction(
	platform: 'stm32' | 'mspm0' | 'hpm',
	xrobotBsp: boolean,
): { label: string; request: CliRunRequest } {
	switch (platform) {
		case 'stm32':
			return {
				label: 'Configure CubeMX (libxr stm32 setup)',
				request: {
					label: 'libxr stm32 setup',
					tool: 'libxr',
					args: xrobotBsp ? ['stm32', 'setup', '-d', '.', '--xrobot'] : ['stm32', 'setup', '-d', '.'],
				},
			};
		case 'hpm':
			return {
				label: 'Set Up HPM Project (libxr hpm setup)',
				request: { label: 'libxr hpm setup', tool: 'libxr', args: ['hpm', 'setup', '-d', '.', xrobotFlag(xrobotBsp)] },
			};
		case 'mspm0':
			return {
				label: 'Set Up MSPM0 Project (libxr mspm0 setup)',
				request: { label: 'libxr mspm0 setup', tool: 'libxr', args: ['mspm0', 'setup', '-d', '.', xrobotFlag(xrobotBsp)] },
			};
	}
}

// A path setting as typed: surrounding whitespace and the quotes of Windows' "Copy as path"
// removed.
export function settingPath(value: string): string {
	const trimmed = value.trim();
	const quoted = /^(["'])(.*)\1$/.exec(trimmed);
	return (quoted ? quoted[2] : trimmed).trim();
}

// The CLI flag for the XRobot choice of a setup.
function xrobotFlag(xrobotBsp: boolean): string {
	return xrobotBsp ? '--xrobot' : '--no-xrobot';
}

// How to start the SysConfig GUI of the installation that holds `cliPath` (the SYSCONFIG_TOOL
// sysconfig_cli.bat or sysconfig_cli.sh) on a project's .syscfg, with the arguments of the SDK
// makefiles' syscfg-gui target (GCC, the product of the MSPM0 SDK, the .syscfg). Windows: what
// sysconfig_gui.bat runs, `nw\nw.exe <dir>\app <arguments>`, so no shell is needed; elsewhere
// sysconfig_gui.sh itself. Undefined when the path is not a sysconfig_cli.
export function sysconfigGuiLaunch(
	cliPath: string,
	sdkDir: string,
	syscfg: string,
	platform: NodeJS.Platform,
): { command: string; args: string[] } | undefined {
	const match = /^(.*[\\/])?sysconfig_cli(\.[A-Za-z0-9]+)?$/.exec(cliPath.trim());
	if (!match) {
		return undefined;
	}
	const dir = match[1] ?? '';
	const product = `${sdkDir.trim().replace(/[\\/]+$/, '')}/.metadata/product.json`;
	const toolArgs = ['--compiler', 'gcc', '--product', product, syscfg];
	if (platform === 'win32') {
		return { command: `${dir}nw\\nw.exe`, args: [`${dir}app`, ...toolArgs] };
	}
	return { command: `${dir}sysconfig_gui.sh`, args: toolArgs };
}

// A workspace-relative path as the `./` + `/` argument the CLI takes.
function arg(rel: string): string {
	return `./${rel.replace(/\\/g, '/').replace(/^\.?\//, '')}`;
}

export type ActionContext = {
	platform: LibxrPlatform;
	xrobotBsp: boolean;
	appMainRel: string;
	libxrConfigRel: string;
	// The directory of the .ioc, relative to the workspace root (an STM32 project).
	projectDir: string;
	// The MCU model of a generated flash_map.hpp (the flash-info default input).
	flashModel?: string;
};

// The CLI actions of a configured project. Every platform also has the one-click Generate LibXR
// Code (an op, not here); the STM32 ones keep the CLI's arguments editable.
export function cliActions(context: ActionContext): { label: string; request: CliRunRequest }[] {
	if (context.platform !== 'stm32') {
		return [];
	}
	const parsedConfig = './.config.yaml';
	const projectDir = context.projectDir || '.';
	const xrobotFlag = context.xrobotBsp ? ' --xrobot' : '';
	const request: CliRunRequest = {
		label: 'libxr gen',
		tool: 'libxr',
		args: ['gen'],
		promptInput: true,
		defaultInput: `-i ${parsedConfig} -d ${projectDir} -o ${arg(context.appMainRel)}${xrobotFlag} --libxr-config ${arg(context.libxrConfigRel)}`,
		inputPrompt: `Example: -i ${parsedConfig} -d ${projectDir} -o ${arg(context.appMainRel)}${xrobotFlag} --libxr-config ${arg(context.libxrConfigRel)}`,
	};
	return [
		setupAction('stm32', context.xrobotBsp),
		{
			label: 'Parse IOC (libxr parse)',
			request: {
				label: 'libxr parse',
				tool: 'libxr',
				args: ['parse'],
				promptInput: true,
				defaultInput: `-d ${projectDir} -o ${parsedConfig} --verbose`,
				inputPrompt: `Example: -d <CubeMXDir> -o ${parsedConfig} --verbose`,
			},
		},
		{ label: 'Generate STM32 Code (libxr gen)', request },
		{
			label: 'Show STM32 Flash Info (libxr stm32 flash-info)',
			request: {
				label: 'libxr stm32 flash-info',
				tool: 'libxr',
				args: ['stm32', 'flash-info'],
				promptInput: true,
				defaultInput: context.flashModel ?? 'STM32F103C8',
				inputPrompt: 'Example: STM32F103C8',
			},
		},
	];
}

// The files the two views follow: the platform inputs of `libxr` (the .ioc of an STM32 project,
// the app.yaml and .hpmpc of an HPM project, the root .syscfg of an MSPM0 project and the main.c
// whose pin calls an HPM project reads), the inputs of `xrobot describe`, and the LibXR config
// and generated sources.
export function watcherPatterns(): string[] {
	return [
		'*.ioc',
		'app.yaml',
		'boards/*/*.hpmpc',
		'*.syscfg',
		'main.c',
		'Modules/modules.yaml',
		'Modules/sources.yaml',
		'xrobot.lock',
		'User/**/*.{yaml,yml}',
		'User/**/*.{c,cc,cpp,cxx,hpp}',
	];
}

// The failure of a libxr without this platform (6.0.0 names only stm32): a sub-command it has
// not heard of, or a project directory it cannot recognize. Says what to do instead of the
// argparse or platform error alone.
export function libxrUpgradeHint(message: string): string | undefined {
	// The CLI answers in English or, with XR_LANG=zh (a Chinese VS Code), in Chinese.
	const unknownCommand = /(invalid choice|无效的选项)[:：]\s*'(mspm0|hpm|pins)'/.test(message);
	// A libxr that knows MSPM0 lists it among the supported platforms; then the folder simply
	// holds no project, which is not a version problem.
	const noPlatform = /(no supported platform recognized|无法识别工程所属的平台)/.test(message) && !/mspm0/.test(message);
	if (unknownCommand || noPlatform) {
		return 'The installed libxr is too old for this project; upgrade it (pip install -U libxr) and run again.';
	}
	return undefined;
}

// The error of an MSPM0 parse without SysConfig: the same variables the CMake build takes are
// also provided by the extension settings.
export function sysconfigEnvHint(message: string): string | undefined {
	if (/SYSCONFIG_TOOL (or|或) MSPM0_SDK_INSTALL_DIR/.test(message)) {
		return (
			'Set SysConfig up for MSPM0: point xrobot.libxr.sysconfigTool and xrobot.libxr.mspm0SdkDir at the tool and the SDK, ' +
			'or build the project once so build*/ holds its SysConfig output.'
		);
	}
	return undefined;
}
