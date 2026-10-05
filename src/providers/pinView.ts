// The pin layout panel: runs `libxr pins -d` in the workspace and shows the package with the
// pins the project selected. The CLI decides what is on the chip; this only draws it.
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { outputChannel, getWorkspaceRoot, startQuiet } from '../cliHost';
import { libxrArgs, type CliRun } from '../cli/xrobotCli';
import { parsePinsOutput } from '../pins/model';
import { detectPinsProject } from '../pins/project';
import { buildView, type ViewData } from '../pins/view';
import { detectIocFiles, getWorkspaceRelativeConfig } from './viewProviders';

type PanelData = ViewData | { error: string };

let panel: vscode.WebviewPanel | undefined;
let currentRun: CliRun | undefined;
let latest: PanelData | undefined;
let generation = 0;

function pageHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	const media = (name: string): vscode.Uri => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('pins.css')}">
<title>Pin Layout</title>
</head>
<body>
<div id="app"><p>Loading…</p></div>
<script nonce="${nonce}" src="${media('pins.js')}"></script>
</body>
</html>`;
}

function post(data: PanelData): void {
	latest = data;
	void panel?.webview.postMessage(data);
}

// Runs `libxr pins -d .` (its paths are relative to the workspace root) and shows the result, or
// the CLI's own message.
export async function refreshPinLayout(): Promise<void> {
	const root = getWorkspaceRoot();
	if (!panel || !root) {
		return;
	}
	currentRun?.cancel();
	const mine = ++generation;
	const configRel = getWorkspaceRelativeConfig('xrobot.libxr.configPath', 'User/libxr_config.yaml').replace(/\\/g, '/');
	const packageName = vscode.workspace.getConfiguration('xrobot.libxr').get<string>('package', '').trim();
	const run = startQuiet('libxr', libxrArgs.pins('.', configRel, packageName || undefined), root);
	currentRun = run;
	const outcome = await run.done;
	if (mine !== generation || outcome.cancelled) {
		return;
	}
	if (!outcome.ok) {
		outputChannel.appendLine(`[pins] ${run.commandLine}: ${outcome.message ?? ''}`);
		post({ error: outcome.message ?? 'libxr pins failed' });
		return;
	}
	const parsed = parsePinsOutput(outcome.stdout);
	if (!parsed.ok) {
		outputChannel.appendLine(`[pins] ${run.commandLine}: ${parsed.error}`);
		post({ error: parsed.error });
		return;
	}
	post(buildView(parsed.result));
}

async function openConfigFile(): Promise<void> {
	const root = getWorkspaceRoot();
	const file = latest && 'configFile' in latest ? latest.configFile : null;
	if (!root || !file) {
		return;
	}
	const absolute = path.resolve(root, file);
	// Only a file inside the workspace; the path comes from the CLI's output.
	if (path.relative(root, absolute).startsWith('..') || path.isAbsolute(path.relative(root, absolute))) {
		return;
	}
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(absolute)));
}

export async function showPinLayout(context: vscode.ExtensionContext): Promise<void> {
	const root = getWorkspaceRoot();
	if (!root) {
		void vscode.window.showInformationMessage('Open a workspace folder to show the pin layout.');
		return;
	}
	if (!detectPinsProject(root, detectIocFiles(root))) {
		void vscode.window.showInformationMessage(
			'No STM32CubeMX .ioc or SysConfig ti_msp_dl_config.h found in the workspace (the pin layout needs one of them).',
		);
		return;
	}
	if (panel) {
		panel.reveal();
	} else {
		const media = vscode.Uri.joinPath(context.extensionUri, 'media');
		panel = vscode.window.createWebviewPanel('xrobot.pinLayout', 'Pin Layout', vscode.ViewColumn.Beside, {
			enableScripts: true,
			localResourceRoots: [media],
			retainContextWhenHidden: true,
		});
		panel.webview.html = pageHtml(panel.webview, context.extensionUri);
		panel.webview.onDidReceiveMessage((message: { type?: string }) => {
			if (message.type === 'ready' && latest) {
				void panel?.webview.postMessage(latest);
			} else if (message.type === 'openConfig') {
				void openConfigFile();
			}
		});
		panel.onDidDispose(() => {
			currentRun?.cancel();
			panel = undefined;
			latest = undefined;
		});
	}
	await refreshPinLayout();
}
