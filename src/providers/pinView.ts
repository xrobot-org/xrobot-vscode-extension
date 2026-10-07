// The pin layout panel: draws the shared `libxr pins` result (pinsService) as the package of the
// chip with the pins the project selected. The CLI decides what is on the chip; this only draws it.
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getWorkspaceRoot, outputChannel } from '../cliHost';
import { pinsService, type PinsState } from '../pinsService';
import { detectPinsProject, listIocFiles } from '../pins/project';
import { buildView, type ViewData } from '../pins/view';
import { NO_PROJECT_MESSAGE } from '../libxrView';
import { openInVendorTool } from '../vendorTools';

type PanelData = ViewData | { error: string };

export type ShowPinLayoutOptions = {
	// Select this peripheral (an instance such as USART1) in the panel.
	peripheral?: string;
};

// Told which peripheral the panel's selection involves (null: none), so the sidebar can follow.
type SelectionHandler = (peripheral: string | null) => void;

let selectionHandler: SelectionHandler | undefined;

export function onPanelSelection(handler: SelectionHandler): void {
	selectionHandler = handler;
}

let panel: vscode.WebviewPanel | undefined;
let latest: PanelData | undefined;
let pendingPeripheral: string | undefined;
let subscription: vscode.Disposable | undefined;

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

function post(message: unknown): void {
	void panel?.webview.postMessage(message);
}

function select(peripheral: string): void {
	post({ type: 'select', peripheral });
}

// Shows a state of the shared result. A run in progress keeps what is shown (the result before it).
function show(state: PinsState): void {
	if (!panel) {
		return;
	}
	if (state.status === 'ok') {
		latest = buildView(state.result);
	} else if (state.status === 'error') {
		latest = { error: state.message };
	} else if (state.status === 'none') {
		latest = { error: NO_PROJECT_MESSAGE };
	} else {
		// A run is going: what is shown stays, marked as being updated.
		post({ type: 'busy' });
		return;
	}
	post({ type: 'data', data: latest });
	if (pendingPeripheral && state.status === 'ok') {
		select(pendingPeripheral);
		pendingPeripheral = undefined;
	}
}

// Opens a file of the project the CLI named (a path relative to the workspace, or absolute). Only a
// file inside the workspace: the path comes from the CLI's output.
async function openProjectFile(file: string | null): Promise<void> {
	const root = getWorkspaceRoot();
	if (!root || !file) {
		return;
	}
	const absolute = path.resolve(root, file);
	const relative = path.relative(root, absolute);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return;
	}
	await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absolute));
}

export async function showPinLayout(context: vscode.ExtensionContext, options: ShowPinLayoutOptions = {}): Promise<void> {
	const root = getWorkspaceRoot();
	if (!root) {
		void vscode.window.showInformationMessage('Open a workspace folder to show the pin layout.');
		return;
	}
	if (!detectPinsProject(root, listIocFiles(root))) {
		void vscode.window.showInformationMessage(NO_PROJECT_MESSAGE);
		return;
	}
	pendingPeripheral = options.peripheral;
	if (panel) {
		panel.reveal(undefined, true);
		if (options.peripheral && pinsService.state.status === 'ok') {
			select(options.peripheral);
			pendingPeripheral = undefined;
		}
		return;
	}
	const media = vscode.Uri.joinPath(context.extensionUri, 'media');
	panel = vscode.window.createWebviewPanel('xrobot.pinLayout', 'Pin Layout', vscode.ViewColumn.Beside, {
		enableScripts: true,
		localResourceRoots: [media],
		retainContextWhenHidden: true,
	});
	panel.webview.html = pageHtml(panel.webview, context.extensionUri);
	panel.webview.onDidReceiveMessage((message: { type?: string; peripheral?: unknown }) => {
		if (message.type === 'ready') {
			// The page loaded: give it what is known, and compute again for a first open.
			if (pinsService.state.status === 'ok' || pinsService.state.status === 'error') {
				show(pinsService.state);
			}
			if (pinsService.state.status !== 'ok') {
				void pinsService.refresh();
			}
		} else if (message.type === 'openConfig') {
			void openProjectFile(latest && 'configFile' in latest ? latest.configFile : null);
		} else if (message.type === 'openSysconfig') {
			if (latest && 'sysconfigFile' in latest) {
				void openInVendorTool(latest.platform, latest.sysconfigFile);
			}
		} else if (message.type === 'showOutput') {
			outputChannel.show(true);
		} else if (message.type === 'selection') {
			selectionHandler?.(typeof message.peripheral === 'string' ? message.peripheral : null);
		}
	});
	subscription = pinsService.onDidChange((state) => show(state));
	panel.onDidDispose(() => {
		subscription?.dispose();
		subscription = undefined;
		panel = undefined;
		latest = undefined;
		pendingPeripheral = undefined;
	});
}
