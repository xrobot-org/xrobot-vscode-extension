import * as vscode from 'vscode';
import {
	editYamlScalar,
	openUrl,
	openWorkspaceFile,
	pickLibxrConfigPath,
	pickWorkspaceFileForSetting,
	runCli,
	type CliRunRequest,
	type OpenFileTarget,
} from '../providers/viewProviders';
import type { InstanceEditTarget } from '../providers/instanceEditor';
import { showPinLayout } from '../providers/pinView';
import {
	addModuleInstance,
	addRepo,
	addSource,
	createModuleWizard,
	deleteModuleInstance,
	deleteRepo,
	deleteSource,
	editModuleInstance,
	editRepoVersion,
	editSourcePriority,
	editSourceUrl,
	selectProduct,
} from './xrobotCommands';

// Tree items pass their target as the first argument; from the command palette the
// argument is absent and the command asks for it (or does nothing when there is none).
export function registerXrobotCommands(context: vscode.ExtensionContext, refreshAll: () => void): void {
	const register = (id: string, handler: (...args: never[]) => unknown): void => {
		context.subscriptions.push(vscode.commands.registerCommand(id, handler));
	};

	register('xrobot.helloWorld', () => {
		void vscode.window.showInformationMessage('Hello World from XRobot!');
	});
	register('xrobot.runCli', async (request?: CliRunRequest) => {
		await runCli(request);
		refreshAll();
	});
	register('xrobot.openFile', (target?: OpenFileTarget | string) => openWorkspaceFile(target));
	register('xrobot.openUrl', (url?: string) => openUrl(url));
	register('xrobot.refreshAll', () => refreshAll());
	register('xrobot.showPinLayout', () => showPinLayout(context));
	register('xrobot.collapseAllViews', async () => {
		await vscode.commands.executeCommand('workbench.actions.treeView.xrobot.libxrView.collapseAll');
		await vscode.commands.executeCommand('workbench.actions.treeView.xrobot.xrobotView.collapseAll');
	});

	register('xrobot.pickLibxrConfigPath', async () => {
		await pickLibxrConfigPath();
		refreshAll();
	});
	register('xrobot.pickLibxrAppMainPath', async () => {
		await pickWorkspaceFileForSetting('xrobot.libxr.appMainPath', ['cpp', 'cc', 'cxx', 'c']);
		refreshAll();
	});
	register('xrobot.editYamlScalar', async (filePath?: string, keyPath?: Array<string | number>) => {
		await editYamlScalar(filePath, keyPath);
		refreshAll();
	});

	register('xrobot.selectProduct', (config?: string) => selectProduct(refreshAll, config));
	register('xrobot.createModuleWizard', () => createModuleWizard());
	register('xrobot.addModuleInstance', () => addModuleInstance(refreshAll));
	register('xrobot.editModuleInstance', (instanceId?: string, target?: InstanceEditTarget) =>
		editModuleInstance(refreshAll, instanceId, target),
	);
	register('xrobot.deleteModuleInstance', (instanceId?: string) => deleteModuleInstance(refreshAll, instanceId));

	register('xrobot.addRepo', () => addRepo(refreshAll));
	register('xrobot.editRepoVersion', (id?: string) => editRepoVersion(refreshAll, id));
	register('xrobot.deleteRepo', (id?: string) => deleteRepo(refreshAll, id));

	register('xrobot.addSource', () => addSource(refreshAll));
	register('xrobot.editSourceUrl', (url?: string) => editSourceUrl(refreshAll, url));
	register('xrobot.editSourcePriority', (url?: string) => editSourcePriority(refreshAll, url));
	register('xrobot.deleteSource', (url?: string) => deleteSource(refreshAll, url));
}
