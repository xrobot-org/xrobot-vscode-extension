import { defineConfig } from '@vscode/test-cli';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use the locally installed VS Code when there is one; otherwise @vscode/test-cli
// downloads a build matching engines.vscode.
const machineCodePath = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');

export default defineConfig({
	files: 'out/test/suite/**/*.test.js',
	...(fs.existsSync(machineCodePath) ? { useInstallation: { fromPath: machineCodePath } } : {}),
	launchArgs: [
		'--disable-updates',
		'--disable-workspace-trust',
		'--user-data-dir',
		path.join(__dirname, '.vscode-test', 'user-data'),
		'--extensions-dir',
		path.join(__dirname, '.vscode-test', 'extensions'),
	],
});
