// Opens a project's configuration in the vendor tool that edits it: the standalone SysConfig GUI
// for an MSPM0 .syscfg, the HPM Pinmux Tool extension for an HPM .hpmpc.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { cliEnv, getWorkspaceRoot } from './cliHost';
import { sysconfigGuiLaunch } from './libxrView';

// The HPMicro extension whose custom editor opens a .hpmpc.
const HPM_PINMUX_TOOL_EXTENSION = 'HPMicro.hpm-pinmux-tool';
const HPM_PINMUX_TOOL_WEB = 'https://tools.hpmicro.com/';

// `file` is the configuration (relative to the workspace, or absolute); only a file inside the
// workspace is opened.
export async function openInVendorTool(platform: string, file: string | null | undefined): Promise<void> {
	const root = getWorkspaceRoot();
	if (!root || !file) {
		return;
	}
	const absolute = path.resolve(root, file);
	const relative = path.relative(root, absolute);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return;
	}
	if (platform === 'mspm0') {
		openInSysconfig(absolute);
	} else if (platform === 'hpm') {
		await openInHpmPinmuxTool(absolute);
	} else {
		await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absolute));
	}
}

// TI has no VS Code editor for a .syscfg: the standalone SysConfig of SYSCONFIG_TOOL edits it,
// with the product of the MSPM0 SDK (the settings xrobot.libxr.sysconfigTool and
// xrobot.libxr.mspm0SdkDir, or the environment variables of the CMake build).
function openInSysconfig(syscfg: string): void {
	const env = cliEnv();
	const tool = env.SYSCONFIG_TOOL ?? '';
	const sdkDir = env.MSPM0_SDK_INSTALL_DIR ?? '';
	if (!tool || !sdkDir) {
		void vscode.window.showErrorMessage(
			'Opening the .syscfg in SysConfig needs the SysConfig command-line tool and the MSPM0 SDK: set ' +
				'xrobot.libxr.sysconfigTool (path of sysconfig_cli.bat or sysconfig_cli.sh) and xrobot.libxr.mspm0SdkDir, ' +
				'or the environment variables SYSCONFIG_TOOL and MSPM0_SDK_INSTALL_DIR.',
		);
		return;
	}
	const launch = sysconfigGuiLaunch(tool, sdkDir, syscfg, process.platform);
	if (!launch) {
		void vscode.window.showErrorMessage(`SYSCONFIG_TOOL is not a sysconfig_cli: ${tool}`);
		return;
	}
	if (!fs.existsSync(launch.command)) {
		void vscode.window.showErrorMessage(
			`The SysConfig GUI was not found at ${launch.command}; the SysConfig installation of ${tool} needs its GUI.`,
		);
		return;
	}
	const child = spawn(launch.command, launch.args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
	child.on('error', (error) => {
		void vscode.window.showErrorMessage(`Failed to start SysConfig: ${error.message}`);
	});
	child.unref();
}

// The HPM Pinmux Tool extension edits a .hpmpc; without it, VS Code would show the file as JSON.
async function openInHpmPinmuxTool(hpmpc: string): Promise<void> {
	if (vscode.extensions.getExtension(HPM_PINMUX_TOOL_EXTENSION)) {
		await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(hpmpc));
		return;
	}
	const show = 'Show the extension';
	const web = 'Open the web tool';
	const choice = await vscode.window.showInformationMessage(
		'The .hpmpc is edited by the HPM Pinmux Tool: install its VS Code extension (HPMicro.hpm-pinmux-tool), or import the file in the web tool.',
		show,
		web,
	);
	if (choice === show) {
		await vscode.commands.executeCommand('workbench.extensions.search', `@id:${HPM_PINMUX_TOOL_EXTENSION}`);
	} else if (choice === web) {
		await vscode.env.openExternal(vscode.Uri.parse(HPM_PINMUX_TOOL_WEB));
	}
}
