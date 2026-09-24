import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { discoverUserXrobotConfigs } from '../providers/workspaceConfigDiscovery';

function writeFile(root: string, rel: string, content = 'x: 1\n'): void {
	const abs = path.join(root, ...rel.split('/'));
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf8');
}

suite('discoverUserXrobotConfigs', () => {
	test('does not treat unrelated YAML files as xrobot config', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xrobot-ext-'));
		try {
			writeFile(tmp, 'User/.config.yaml', 'generated: true\n');
			writeFile(tmp, 'User/settings.yaml', 'foo: bar\n');
			writeFile(tmp, 'User/libxr_config.yaml', 'libxr: true\n');

			assert.deepStrictEqual(discoverUserXrobotConfigs(tmp), []);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('finds XRobot-shaped YAML configs under User/ by content', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xrobot-ext-'));
		try {
			writeFile(tmp, 'User/xrobot.yaml', 'modules: []\n');
			writeFile(tmp, 'User/RobotConfig/hero.yaml', 'modules: []\nsettings:\n  monitor_sleep_ms: 1000\n');
			writeFile(tmp, 'User/subdir/my_config.yml', 'settings: {}\n');
			writeFile(tmp, 'User/libxr_xrobot_mix.yaml', 'modules: []\n'); // contains libxr => not xrobot config

			assert.deepStrictEqual(discoverUserXrobotConfigs(tmp), [
				'User/RobotConfig/hero.yaml',
				'User/subdir/my_config.yml',
				'User/xrobot.yaml',
			]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
