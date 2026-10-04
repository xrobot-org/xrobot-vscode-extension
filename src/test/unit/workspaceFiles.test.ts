import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseLsRemote } from '../../cli/gitRefs';
import { editSource, isProtectedSourceUrl, readModuleRequests, readSources } from '../../providers/workspaceFiles';

const OFFICIAL = 'https://xrobot.work/xrobot-modules/index.yaml';

// Unsorted on purpose: display order (by priority) differs from file order.
const SOURCES = `# catalogs
sources:
- url: https://example.org/team/index.yaml
  priority: 5
- url: ${OFFICIAL}
  priority: 0
- url: ./local/index.yaml # a local catalog
  priority: 1
`;

function withFile(content: string, run: (file: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrobot sources '));
	const file = path.join(dir, 'sources.yaml');
	fs.writeFileSync(file, content, 'utf8');
	try {
		run(file);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

suite('sources.yaml', () => {
	test('sources are listed by priority and the official one is protected', () => {
		withFile(SOURCES, (file) => {
			const result = readSources(file);
			assert.ok(result.ok);
			assert.deepStrictEqual(
				result.value.map((s) => [s.url, s.priority, s.protected]),
				[
					[OFFICIAL, 0, true],
					['./local/index.yaml', 1, false],
					['https://example.org/team/index.yaml', 5, false],
				],
			);
			assert.ok(isProtectedSourceUrl(`${OFFICIAL}/`));
		});
	});

	test('an edit changes the entry with that URL and nothing else', () => {
		withFile(SOURCES, (file) => {
			editSource(file, './local/index.yaml', { kind: 'priority', priority: 3 });
			assert.strictEqual(fs.readFileSync(file, 'utf8'), SOURCES.replace('  priority: 1\n', '  priority: 3\n'));
			editSource(file, 'https://example.org/team/index.yaml', { kind: 'url', url: 'https://example.org/other/index.yaml' });
			assert.strictEqual(
				fs.readFileSync(file, 'utf8'),
				SOURCES.replace('  priority: 1\n', '  priority: 3\n').replace('example.org/team/', 'example.org/other/'),
			);
		});
	});

	test('removal keeps comments and the other entries', () => {
		withFile(SOURCES, (file) => {
			editSource(file, 'https://example.org/team/index.yaml', { kind: 'remove' });
			const text = fs.readFileSync(file, 'utf8');
			assert.ok(!text.includes('example.org/team'));
			assert.ok(text.includes('# catalogs') && text.includes('# a local catalog') && text.includes(OFFICIAL));
		});
	});

	test('the official source is never changed or removed', () => {
		withFile(SOURCES, (file) => {
			for (const edit of [{ kind: 'priority', priority: 9 }, { kind: 'url', url: 'https://x/index.yaml' }, { kind: 'remove' }] as const) {
				assert.throws(() => editSource(file, OFFICIAL, edit), /official source/);
			}
			assert.throws(() => editSource(file, './local/index.yaml', { kind: 'url', url: OFFICIAL }), /official source/);
			assert.strictEqual(fs.readFileSync(file, 'utf8'), SOURCES);
		});
	});

	test('absent or duplicated URLs are refused without writing', () => {
		withFile(SOURCES, (file) => {
			assert.throws(() => editSource(file, 'https://nowhere/index.yaml', { kind: 'remove' }), /is not in/);
			assert.throws(
				() => editSource(file, './local/index.yaml', { kind: 'url', url: 'https://example.org/team/index.yaml' }),
				/already listed/,
			);
			assert.strictEqual(fs.readFileSync(file, 'utf8'), SOURCES);
		});
		const duplicated = `sources:\n  - url: a/index.yaml\n  - url: a/index.yaml\n`;
		withFile(duplicated, (file) => {
			assert.throws(() => editSource(file, 'a/index.yaml', { kind: 'remove' }), /listed 2 times/);
			assert.strictEqual(fs.readFileSync(file, 'utf8'), duplicated);
		});
	});

	test('indented lists and CRLF line endings are kept', () => {
		const text = 'sources:\r\n  - url: a/index.yaml\r\n    priority: 1\r\n  - url: b/index.yaml\r\n';
		withFile(text, (file) => {
			editSource(file, 'a/index.yaml', { kind: 'priority', priority: 2 });
			assert.strictEqual(fs.readFileSync(file, 'utf8'), text.replace('priority: 1', 'priority: 2'));
		});
	});
});

suite('modules.yaml', () => {
	test('string and mapping requests', () => {
		withFile('xrobot: 1.0.0\nmodules:\n- a/B@same-or-dev\n- c/D\n- {id: e/F, ref: refs/tags/v1, context_ref: refs/heads/main}\n', (file) => {
			const result = readModuleRequests(file);
			assert.ok(result.ok);
			assert.deepStrictEqual(result.value, [
				{ id: 'a/B', ref: 'same-or-dev', plain: true },
				{ id: 'c/D', plain: true },
				{ id: 'e/F', ref: 'refs/tags/v1', plain: false },
			]);
		});
	});

	test('a malformed file is an error, not an empty list', () => {
		withFile('modules: a/B\n', (file) => {
			const result = readModuleRequests(file);
			assert.ok(!result.ok);
		});
	});
});

suite('git ls-remote', () => {
	test('branches and tags (peeled tags once)', () => {
		const refs = parseLsRemote('1\trefs/heads/main\n2\trefs/heads/dev\n3\trefs/tags/v1.0\n4\trefs/tags/v1.0^{}\n5\trefs/tags/v1.1\n');
		assert.deepStrictEqual(refs, { branches: ['dev', 'main'], tags: ['v1.1', 'v1.0'] });
	});
});
