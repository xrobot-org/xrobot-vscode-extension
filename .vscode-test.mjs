import { defineConfig } from '@vscode/test-cli';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const machineCodePath = path.join(
	process.env.LOCALAPPDATA ?? '',
	'Programs',
	'Microsoft VS Code',
	'Code.exe',
);

export default defineConfig({
	files: 'out/test/**/*.test.js',
	useInstallation: {
		fromPath: machineCodePath,
	},
	launchArgs: [
		'--disable-updates',
		'--disable-workspace-trust',
		'--user-data-dir',
		path.join(__dirname, '.vscode-test', 'user-data'),
		'--extensions-dir',
		path.join(__dirname, '.vscode-test', 'extensions'),
	],
});
