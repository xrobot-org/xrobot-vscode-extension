import * as vscode from 'vscode';
import { LibxrTreeProvider, XrobotTreeProvider } from './providers/viewProviders';
import { registerXrobotCommands, registerWatchers, checkCliPrerequisites } from './commands/commandHandlers';

export function activate(context: vscode.ExtensionContext): void {
	const libxrProvider = new LibxrTreeProvider();
	const xrobotProvider = new XrobotTreeProvider();

	const refreshAll = (): void => {
		libxrProvider.refresh();
		xrobotProvider.refresh();
	};

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('xrobot.libxrView', libxrProvider),
		vscode.window.registerTreeDataProvider('xrobot.xrobotView', xrobotProvider),
	);

	registerXrobotCommands(context, refreshAll);
	registerWatchers(context, refreshAll);
	checkCliPrerequisites();
}

export function deactivate(): void {}
