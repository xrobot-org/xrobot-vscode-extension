import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { asRecord, parseYamlSafe } from '../yaml/yamlStore';
import { guardedWriteYamlRoot } from '../providers/yamlWriteGuard';

suite('guardedWriteYamlRoot', () => {
	test('writes and validates successfully', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xrobot-ext-'));
		try {
			const filePath = path.join(tmp, 'config.yaml');
			fs.writeFileSync(filePath, 'before: true\n', 'utf8');
			const result = guardedWriteYamlRoot(filePath, { device_aliases: { led: { aliases: ['LED'] } } }, (root) =>
				Boolean(asRecord(root.device_aliases)),
			);

			assert.strictEqual(result.ok, true);
			const parsed = parseYamlSafe(filePath);
			assert.strictEqual(parsed.ok, true);
			assert.ok(parsed.ok);
			const root = asRecord(parsed.value);
			assert.ok(root);
			assert.ok(asRecord(root?.device_aliases));
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('rolls back when validation fails', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xrobot-ext-'));
		try {
			const filePath = path.join(tmp, 'config.yaml');
			const previous = 'device_aliases:\n  led:\n    aliases:\n      - LED\n';
			fs.writeFileSync(filePath, previous, 'utf8');
			const result = guardedWriteYamlRoot(filePath, { generated: true }, (root) => Boolean(asRecord(root.device_aliases)));

			assert.strictEqual(result.ok, false);
			assert.strictEqual(result.ok ? '' : result.stage, 'validate');
			const next = fs.readFileSync(filePath, 'utf8');
			assert.strictEqual(next, previous);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
