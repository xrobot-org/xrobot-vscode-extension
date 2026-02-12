import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { hasUsableXrobotConfig } from '../providers/xrobotConfigUtils';

function writeFile(root: string, rel: string, content: string): string {
	const abs = path.join(root, ...rel.split('/'));
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf8');
	return abs;
}

suite('hasUsableXrobotConfig', () => {
	test('returns false when file is missing', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xrobot-ext-'));
		try {
			assert.strictEqual(hasUsableXrobotConfig(path.join(tmp, 'User', 'xrobot.yaml')), false);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('returns true when yaml is xrobot-shaped', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xrobot-ext-'));
		try {
			const configPath = writeFile(tmp, 'User/xrobot.yaml', 'modules: []\n');
			assert.strictEqual(hasUsableXrobotConfig(configPath), true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('returns false when yaml is unrelated', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xrobot-ext-'));
		try {
			const configPath = writeFile(tmp, 'User/xrobot.yaml', 'generated: true\n');
			assert.strictEqual(hasUsableXrobotConfig(configPath), false);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
