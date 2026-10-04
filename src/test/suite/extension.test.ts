import * as assert from 'assert';
import * as vscode from 'vscode';

// Runs inside VS Code (`npm run test:vscode`), without a workspace folder.
suite('Extension', () => {
	test('activates and registers its commands', async () => {
		const extension = vscode.extensions.getExtension('XRobot.xrobot');
		assert.ok(extension);
		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		for (const id of [
			'xrobot.selectProduct',
			'xrobot.addModuleInstance',
			'xrobot.editModuleInstance',
			'xrobot.deleteModuleInstance',
			'xrobot.addRepo',
			'xrobot.editRepoVersion',
			'xrobot.deleteRepo',
			'xrobot.addSource',
			'xrobot.editSourceUrl',
			'xrobot.editSourcePriority',
			'xrobot.deleteSource',
		]) {
			assert.ok(commands.includes(id), id);
		}
	});

	test('commands started without a target and without a BSP do nothing', async () => {
		for (const id of ['xrobot.deleteRepo', 'xrobot.deleteSource', 'xrobot.deleteModuleInstance', 'xrobot.editSourcePriority']) {
			await vscode.commands.executeCommand(id);
		}
	});
});
