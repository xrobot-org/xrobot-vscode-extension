import * as vscode from 'vscode';
import {
	addHardwareAlias,
	addModuleInstance,
	addRepoEntry,
	addSourceEntry,
	checkCliPrerequisites,
	createModuleWizard,
	deleteHardwareAlias,
	deleteModuleInstance,
	deleteRepo,
	deleteSource,
	editHardwareAlias,
	editModuleInstance,
	editRepoName,
	editRepoVersion,
	editSourceMirror,
	editSourcePriority,
	editSourceUrl,
	editYamlScalar,
	openUrl,
	openWorkspaceFile,
	outputChannel,
	pickLibxrConfigPath,
	pickWorkspaceFileForSetting,
	pickXrobotConfigPath,
	registerWatchers,
	runCli,
	type CliRunRequest,
	type OpenFileTarget,
} from '../providers/viewProviders';

export { checkCliPrerequisites, registerWatchers };

export function registerXrobotCommands(context: vscode.ExtensionContext, refreshAll: () => void): void {
	context.subscriptions.push(outputChannel);

	context.subscriptions.push(
		vscode.commands.registerCommand('xrobot.helloWorld', () => {
			vscode.window.showInformationMessage('Hello World from XRobot!');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('xrobot.runCli', async (request: CliRunRequest) => {
			await runCli(request);
		}),
		vscode.commands.registerCommand('xrobot.openFile', async (target: OpenFileTarget | string) => {
			await openWorkspaceFile(target);
		}),
		vscode.commands.registerCommand('xrobot.openUrl', async (url: string) => {
			await openUrl(url);
		}),
		vscode.commands.registerCommand('xrobot.refreshAll', () => {
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.collapseAllViews', async () => {
			await vscode.commands.executeCommand('workbench.actions.treeView.xrobot.libxrView.collapseAll');
			await vscode.commands.executeCommand('workbench.actions.treeView.xrobot.xrobotView.collapseAll');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('xrobot.pickLibxrConfigPath', async () => {
			await pickLibxrConfigPath();
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.pickLibxrAppMainPath', async () => {
			await pickWorkspaceFileForSetting('xrobot.libxr.appMainPath', ['cpp', 'cc', 'cxx', 'c']);
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.pickXrobotConfigPath', async () => {
			await pickXrobotConfigPath();
			refreshAll();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('xrobot.editYamlScalar', async (filePath: string, keyPath: Array<string | number>) => {
			await editYamlScalar(filePath, keyPath);
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.createModuleWizard', async () => {
			await createModuleWizard();
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.addModuleInstance', async () => {
			await addModuleInstance();
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.editModuleInstance', async (index: number) => {
			await editModuleInstance(index);
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.deleteModuleInstance', async (index: number) => {
			await deleteModuleInstance(index);
			refreshAll();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('xrobot.addRepo', async () => {
			await addRepoEntry();
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.editRepoName', async (index: number) => {
			await editRepoName(index);
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.editRepoVersion', async (index: number) => {
			await editRepoVersion(index);
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.deleteRepo', async (index: number) => {
			await deleteRepo(index);
			refreshAll();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('xrobot.addSource', async () => {
			await addSourceEntry();
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.editSourceUrl', async (index: number) => {
			await editSourceUrl(index);
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.editSourcePriority', async (index: number) => {
			await editSourcePriority(index);
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.editSourceMirror', async (index: number) => {
			await editSourceMirror(index);
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.deleteSource', async (index: number) => {
			await deleteSource(index);
			refreshAll();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('xrobot.addHardwareAlias', async (entryKey: string) => {
			await addHardwareAlias(entryKey);
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.editHardwareAlias', async (entryKey: string, aliasIndex: number) => {
			await editHardwareAlias(entryKey, aliasIndex);
			refreshAll();
		}),
		vscode.commands.registerCommand('xrobot.deleteHardwareAlias', async (entryKey: string, aliasIndex: number) => {
			await deleteHardwareAlias(entryKey, aliasIndex);
			refreshAll();
		}),
	);
}
