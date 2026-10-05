import * as vscode from 'vscode';
import { LibxrTreeProvider, XrobotTreeProvider, registerWatchers } from './providers/viewProviders';
import { registerXrobotCommands } from './commands/commandHandlers';
import { checkDependencies } from './commands/xrobotCommands';
import { initCliHost, outputChannel } from './cliHost';
import { pinsService } from './pinsService';
import { onPanelSelection } from './providers/pinView';

// File events arrive in bursts (a CLI rewrites several files); one refresh per burst
// avoids starting and cancelling several `xrobot describe` runs.
const REFRESH_DELAY_MS = 300;

export function activate(context: vscode.ExtensionContext): void {
	initCliHost(context);
	const libxrProvider = new LibxrTreeProvider();
	const xrobotProvider = new XrobotTreeProvider();

	const refreshNow = (): void => {
		libxrProvider.refresh();
		xrobotProvider.refresh();
		void pinsService.refresh();
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const refreshSoon = (): void => {
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = undefined;
			refreshNow();
		}, REFRESH_DELAY_MS);
	};
	context.subscriptions.push({ dispose: () => timer && clearTimeout(timer) });

	const libxrView = vscode.window.createTreeView('xrobot.libxrView', { treeDataProvider: libxrProvider, showCollapseAll: true });
	// What is selected in the pin layout panel is selected in the Peripherals group too.
	onPanelSelection((name) => libxrProvider.revealPeripheral(libxrView, name));
	context.subscriptions.push(
		libxrView,
		vscode.window.createTreeView('xrobot.xrobotView', { treeDataProvider: xrobotProvider, showCollapseAll: true }),
	);

	// The tree shows the shared `libxr pins` result; it redraws when a run finishes.
	context.subscriptions.push(pinsService.onDidChange(() => libxrProvider.refresh()));
	registerXrobotCommands(context, refreshNow);
	registerWatchers(context, refreshSoon);
	void pinsService.refresh();
	// Asynchronous and only in XRobot BSPs: activation is not blocked by process probes.
	void checkDependencies(context.extensionPath).catch((error: unknown) => {
		outputChannel.appendLine(`[check] ${error instanceof Error ? error.message : String(error)}`);
	});
}

export function deactivate(): void {}
