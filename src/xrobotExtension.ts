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

	const libxrView = vscode.window.createTreeView('xrobot.libxrView', {
		treeDataProvider: libxrProvider,
		showCollapseAll: true,
	});
	const xrobotView = vscode.window.createTreeView('xrobot.xrobotView', {
		treeDataProvider: xrobotProvider,
		showCollapseAll: true,
	});
	context.subscriptions.push(libxrView, xrobotView);

	registerXrobotCommands(context, refreshAll);
	registerWatchers(context, refreshAll);
	checkCliPrerequisites();
}

export function deactivate(): void {}
