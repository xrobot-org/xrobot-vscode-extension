import * as assert from 'assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { decodeUtf8, failureMessage, findExecutable } from '../../cli/process';
import {
	PYTHON_BOOTSTRAP,
	cliEnvironment,
	configHash,
	findPython,
	formatCommandLine,
	libxrArgs,
	pythonHasModule,
	resolveInvocation,
	startInvocation,
	valuePath,
	xrobotArgs,
	type Invocation,
} from '../../cli/xrobotCli';

// A stand-in for the `xrobot` console script, run with this Node binary. It records its
// argv and working directory, prints describe-like JSON containing Chinese text in two
// writes that split a UTF-8 character, and fails like XRobot (message on stderr, exit 1).
const FAKE_XROBOT = String.raw`
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.FAKE_XROBOT_LOG) {
	fs.writeFileSync(process.env.FAKE_XROBOT_LOG, JSON.stringify({ args, cwd: process.cwd(), encoding: process.env.PYTHONIOENCODING }));
}
if (args.includes('describe')) {
	const bytes = Buffer.from(JSON.stringify({ schema: 1, value: '"闪烁"' }) + '\n', 'utf8');
	const cut = bytes.indexOf(Buffer.from('闪', 'utf8')) + 1;
	process.stdout.write(bytes.subarray(0, cut), () => {
		setTimeout(() => process.stdout.write(bytes.subarray(cut)), 50);
	});
} else if (args.includes('fail')) {
	process.stderr.write('warning: installed xrobot 1.0.0 differs from the pinned 0.9\n');
	process.stderr.write('User/xrobot.yaml: led: named arguments do not match a constructor\n');
	process.exitCode = 1;
} else {
	process.stdout.write('ok\n');
}
`;

function tempDir(prefix: string): string {
	// A space in every path: paths with spaces must reach the tool unchanged.
	return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix} `));
}

suite('xrobot argument builders', () => {
	const root = path.join(os.tmpdir(), 'my bsp');
	const config = path.join(root, 'User', 'RobotConfig', 'hero.yaml');

	test('every verb names the BSP with -C and takes absolute paths', () => {
		assert.deepStrictEqual(xrobotArgs.describe(root), ['-C', root, 'describe']);
		assert.deepStrictEqual(xrobotArgs.describe(root, config), ['-C', root, 'describe', '-c', config]);
		assert.deepStrictEqual(xrobotArgs.gen(root, config), ['-C', root, 'gen', '-c', config]);
		assert.deepStrictEqual(xrobotArgs.init(root), ['-C', root, 'init']);
		assert.deepStrictEqual(xrobotArgs.setup(root), ['-C', root, 'setup']);
		assert.deepStrictEqual(xrobotArgs.setup(root, { kind: 'frozen' }), ['-C', root, 'setup', '--frozen']);
		assert.deepStrictEqual(xrobotArgs.setup(root, { kind: 'update' }), ['-C', root, 'setup', '--update']);
		assert.deepStrictEqual(xrobotArgs.setup(root, { kind: 'update', modules: ['a/B'] }), ['-C', root, 'setup', '--update', 'a/B']);
		assert.deepStrictEqual(xrobotArgs.format(root, true), ['-C', root, 'format', '--check']);
		assert.deepStrictEqual(xrobotArgs.moduleAdd(root, 'xrobot-org/BlinkLED@same'), ['-C', root, 'module', 'add', 'xrobot-org/BlinkLED@same']);
		assert.deepStrictEqual(xrobotArgs.moduleRemove(root, 'xrobot-org/BlinkLED'), ['-C', root, 'module', 'remove', 'xrobot-org/BlinkLED']);
	});

	test('instance verbs: -c before the action, JSON value as one element, --if-match', () => {
		assert.deepStrictEqual(xrobotArgs.instanceAdd(root, config, 'xrobot-org/BlinkLED'), [
			'-C', root, 'instance', '-c', config, 'add', 'xrobot-org/BlinkLED',
		]);
		assert.deepStrictEqual(xrobotArgs.instanceAdd(root, config, 'xrobot-org/BlinkLED', 'led'), [
			'-C', root, 'instance', '-c', config, 'add', 'xrobot-org/BlinkLED', '--id', 'led',
		]);
		assert.deepStrictEqual(xrobotArgs.instanceSet(root, config, 'led', 'args.name', '"闪烁 a"', 'f'.repeat(64)), [
			'-C', root, 'instance', '-c', config, 'set', '--json', 'led', 'args.name', '"\\"闪烁 a\\""', '--if-match', 'f'.repeat(64),
		]);
		assert.deepStrictEqual(xrobotArgs.instanceSet(root, config, 'm', 'args.param', { reverse: 'true' }).slice(-1), ['{"reverse":"true"}']);
		assert.deepStrictEqual(xrobotArgs.instanceRemove(root, config, 'led'), ['-C', root, 'instance', '-c', config, 'remove', 'led']);
		assert.deepStrictEqual(xrobotArgs.instanceRename(root, config, 'led', 'status'), [
			'-C', root, 'instance', '-c', config, 'rename', 'led', 'status',
		]);
	});

	test('source: --sources precedes the sub-command, add-source takes URL then --priority', () => {
		const sources = path.join(root, 'Modules', 'sources.yaml');
		assert.deepStrictEqual(xrobotArgs.source(root, sources, ['add-source', 'https://x/index.yaml', '--priority', '2']), [
			'-C', root, 'source', '--sources', sources, 'add-source', 'https://x/index.yaml', '--priority', '2',
		]);
		assert.deepStrictEqual(xrobotArgs.source(root, sources, ['get', 'a/B']), ['-C', root, 'source', '--sources', sources, 'get', 'a/B']);
	});

	test('new-module passes each declaration as its own argument', () => {
		assert.deepStrictEqual(
			xrobotArgs.newModule({
				name: 'Blink',
				description: 'blinks',
				constructorParameters: ['LibXR::GPIO& led', 'uint32_t cycle = 250'],
				templateParameters: ['typename T'],
				templateArguments: ['float'],
				depends: ['a/B', 'c/D@v1'],
				outDir: path.join(root, 'out dir'),
			}),
			[
				'new-module', 'Blink', '--desc', 'blinks',
				'--constructor', 'LibXR::GPIO& led', '--constructor', 'uint32_t cycle = 250',
				'--template', 'typename T', '--template-arg', 'float',
				'--depends', 'a/B', '--depends', 'c/D@v1', '--out', path.join(root, 'out dir'),
			],
		);
	});

	test('constructor switch: the whole list is one JSON element for PATH args', () => {
		const list = [{ led: 'LED_B' }, { frequency_hz: '2.0f' }];
		assert.deepStrictEqual(xrobotArgs.instanceSet(root, config, 'led', valuePath('args', []), list, 'a'.repeat(64)), [
			'-C', root, 'instance', '-c', config, 'set', '--json', 'led', 'args', '[{"led":"LED_B"},{"frequency_hz":"2.0f"}]', '--if-match', 'a'.repeat(64),
		]);
	});

	test('value paths follow the instance set syntax', () => {
		assert.strictEqual(valuePath('args', []), 'args');
		assert.strictEqual(valuePath('args', ['param']), 'args.param');
		assert.strictEqual(valuePath('args', ['param', 'timing', 'on_ms']), 'args.param.timing.on_ms');
		assert.strictEqual(valuePath('args', ['topics', 1, 'name']), 'args.topics[1].name');
		assert.strictEqual(valuePath('template_args', [0]), 'template_args[0]');
		assert.throws(() => valuePath('args', ['param', 'not an id']), /not an identifier/);
	});

	test('--if-match hash is sha256 of the file with CRLF normalized to LF', () => {
		const lf = Buffer.from('modules:\n  - id: 闪烁\n', 'utf8');
		const crlf = Buffer.from('modules:\r\n  - id: 闪烁\r\n', 'utf8');
		const expected = crypto.createHash('sha256').update(lf).digest('hex');
		assert.strictEqual(configHash(lf), expected);
		assert.strictEqual(configHash(crlf), expected);
		assert.notStrictEqual(configHash(Buffer.from('a\rb')), configHash(Buffer.from('ab')));
	});

	test('command lines are displayed with quoting', () => {
		assert.strictEqual(formatCommandLine('xrobot', ['-C', 'a b', 'set', '"x"']), 'xrobot -C "a b" set "\\"x\\""');
	});
});

suite('libxr argument builders', () => {
	test('parse writes the .config.yaml that gen then reads', () => {
		assert.deepStrictEqual(libxrArgs.parse('.', './.config.yaml'), ['parse', '-d', '.', '-o', './.config.yaml']);
		assert.deepStrictEqual(
			libxrArgs.gen('./.config.yaml', './User/app_main.cpp', './User/libxr_config.yaml', true),
			['gen', '-i', './.config.yaml', '-o', './User/app_main.cpp', '--xrobot', '--libxr-config', './User/libxr_config.yaml'],
		);
		assert.deepStrictEqual(
			libxrArgs.gen('./.config.yaml', './User/app_main.cpp', './User/libxr_config.yaml', false),
			['gen', '-i', './.config.yaml', '-o', './User/app_main.cpp', '--libxr-config', './User/libxr_config.yaml'],
		);
	});
});

suite('CLI environment and tool resolution', () => {
	test('PYTHONIOENCODING is utf-8 and extraPath is appended once', () => {
		const sep = process.platform === 'win32' ? ';' : ':';
		const env = cliEnvironment({ PATH: ['/a', '/b'].join(sep), PYTHONIOENCODING: 'gbk' }, ['/b', '/c'].join(sep));
		assert.strictEqual(env.PYTHONIOENCODING, 'utf-8');
		const entries = (env.PATH ?? '').split(sep);
		assert.deepStrictEqual(entries.filter((e) => e === '/b').length, 1);
		assert.ok(entries.includes('/c'));
	});

	test('XR_LANG follows the display language unless it is set', () => {
		assert.strictEqual(cliEnvironment({ PATH: '' }, '', process.platform, 'zh-cn').XR_LANG, 'zh');
		assert.strictEqual(cliEnvironment({ PATH: '' }, '', process.platform, 'en').XR_LANG, 'en');
		assert.strictEqual(cliEnvironment({ PATH: '', XR_LANG: 'en' }, '', process.platform, 'zh-cn').XR_LANG, 'en');
		assert.strictEqual(cliEnvironment({ PATH: '' }, '').XR_LANG, undefined);
	});

	test('pip user script directories are added to PATH', () => {
		const base = process.platform === 'win32' ? 'C:\\u' : '/u';
		const env = cliEnvironment({ PATH: '', PYTHONUSERBASE: base }, '');
		const expected = process.platform === 'win32' ? 'C:\\u\\Scripts' : '/u/bin';
		assert.ok((env.PATH ?? '').includes(expected));
	});

	test('the console script on PATH is used directly', () => {
		const dir = tempDir('xrobot-bin');
		try {
			const name = process.platform === 'win32' ? 'xrobot.exe' : 'xrobot';
			fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n');
			fs.chmodSync(path.join(dir, name), 0o755);
			const env = { PATH: dir };
			assert.strictEqual(findExecutable('xrobot', env), path.join(dir, name));
			const invocation = resolveInvocation('xrobot', { env, extensionDir: '/ext', workspaceRoot: '/ws' });
			assert.deepStrictEqual(invocation, { command: path.join(dir, name), prefix: [], cwd: '/ws', display: 'xrobot' });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('.cmd/.bat files are not executables (they would need a shell)', function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		const dir = tempDir('xrobot-cmd');
		try {
			fs.writeFileSync(path.join(dir, 'xrobot.cmd'), '@echo off\n');
			assert.strictEqual(findExecutable('xrobot', { PATH: dir }), undefined);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('without the console script the Python module runs from the extension directory', () => {
		const env = { PATH: '' };
		const invocation = resolveInvocation('xrobot', { env, python: process.execPath, extensionDir: '/ext dir', workspaceRoot: '/my ws' });
		assert.deepStrictEqual(invocation, {
			command: process.execPath,
			prefix: ['-c', PYTHON_BOOTSTRAP, '/my ws', 'xrobot.cli'],
			cwd: '/ext dir',
			display: `${process.execPath} -m xrobot.cli`,
		});
		assert.strictEqual(resolveInvocation('xrobot', { env, python: '', extensionDir: '/e', workspaceRoot: '/w' }), undefined);
		assert.strictEqual(resolveInvocation('unknown_tool', { env, python: process.execPath, extensionDir: '/e', workspaceRoot: '/w' }), undefined);
	});
});

suite('running the CLI (fake xrobot)', () => {
	let dir: string;
	let invocation: Invocation;
	let log: string;
	const env = (): NodeJS.ProcessEnv => cliEnvironment({ ...process.env, FAKE_XROBOT_LOG: log }, '');

	setup(() => {
		dir = tempDir('fake xrobot');
		const script = path.join(dir, 'fake xrobot.js');
		fs.writeFileSync(script, FAKE_XROBOT, 'utf8');
		log = path.join(dir, 'log.json');
		invocation = { command: process.execPath, prefix: [script], cwd: dir, display: 'xrobot' };
	});

	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('arguments arrive unchanged: spaces, quotes, JSON and non-ASCII text', async () => {
		const root = path.join(dir, 'my bsp');
		const args = xrobotArgs.instanceSet(root, path.join(root, 'User', 'x y.yaml'), 'led', 'args.name', '"闪烁" & | > $HOME %PATH%');
		const outcome = await startInvocation(invocation, 'xrobot', args, env()).done;
		assert.ok(outcome.ok, outcome.message);
		const recorded = JSON.parse(fs.readFileSync(log, 'utf8'));
		assert.deepStrictEqual(recorded.args, args);
		assert.strictEqual(fs.realpathSync(recorded.cwd), fs.realpathSync(dir));
		assert.strictEqual(recorded.encoding, 'utf-8');
	});

	test('a constructor switch reaches the tool as one args list', async () => {
		const root = path.join(dir, 'my bsp');
		const list = [{ led: '"闪烁"' }, { frequency_hz: '2.0f' }, { inverted: null }];
		const args = xrobotArgs.instanceSet(root, path.join(root, 'User', 'xrobot.yaml'), 'blink', 'args', list, 'b'.repeat(64));
		const outcome = await startInvocation(invocation, 'xrobot', args, env()).done;
		assert.ok(outcome.ok, outcome.message);
		const recorded = JSON.parse(fs.readFileSync(log, 'utf8'));
		const at = recorded.args.indexOf('args');
		assert.deepStrictEqual(recorded.args.slice(at - 3, at), ['set', '--json', 'blink']);
		assert.deepStrictEqual(JSON.parse(recorded.args[at + 1]), list);
		assert.deepStrictEqual(recorded.args.slice(at + 2), ['--if-match', 'b'.repeat(64)]);
	});

	test('stdout is decoded as UTF-8 even when a character is split across chunks', async () => {
		let streamed = '';
		const outcome = await startInvocation(invocation, 'xrobot', ['describe'], env(), { onStdout: (t) => (streamed += t) }).done;
		assert.ok(outcome.ok);
		assert.strictEqual(JSON.parse(outcome.stdout).value, '"闪烁"');
		assert.strictEqual(streamed, outcome.stdout);
		assert.ok(!outcome.stdout.includes('\uFFFD'));
	});

	test('exit code 1 is a failure carrying the stderr message (not the warning)', async () => {
		const outcome = await startInvocation(invocation, 'xrobot', ['gen', 'fail'], env()).done;
		assert.strictEqual(outcome.ok, false);
		assert.strictEqual(outcome.code, 1);
		assert.strictEqual(outcome.found, true);
		assert.strictEqual(outcome.message, 'User/xrobot.yaml: led: named arguments do not match a constructor');
	});

	test('a missing tool is reported, not run', async () => {
		const unresolved = await startInvocation(undefined, 'xrobot', ['describe'], env()).done;
		assert.strictEqual(unresolved.ok, false);
		assert.strictEqual(unresolved.found, false);
		assert.match(unresolved.message ?? '', /xrobot was not found/);
		// Without -U, pip keeps an installed xrobot 0.x.
		assert.match(unresolved.message ?? '', /pip install -U xrobot/);
		const missing = await startInvocation({ ...invocation, command: path.join(dir, 'no such xrobot') }, 'xrobot', [], env()).done;
		assert.strictEqual(missing.ok, false);
		assert.strictEqual(missing.found, false);
	});

	test('the output of a real executable found on PATH (POSIX)', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const bin = path.join(dir, 'bin dir');
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, 'xrobot'), `#!${process.execPath}\n${FAKE_XROBOT}`, 'utf8');
		fs.chmodSync(path.join(bin, 'xrobot'), 0o755);
		const pathEnv = cliEnvironment({ PATH: bin, FAKE_XROBOT_LOG: log }, '');
		const resolved = resolveInvocation('xrobot', { env: pathEnv, extensionDir: dir, workspaceRoot: dir });
		assert.strictEqual(resolved?.command, path.join(bin, 'xrobot'));
		const outcome = await startInvocation(resolved, 'xrobot', ['describe'], pathEnv).done;
		assert.ok(outcome.ok, outcome.message);
		assert.strictEqual(JSON.parse(outcome.stdout).value, '"闪烁"');
	});
});

suite('Python fallback bootstrap', () => {
	test('runs the module found on sys.path, never one from the workspace, in the workspace', async function () {
		const python = findPython({ env: process.env });
		if (!python) {
			this.skip();
			return;
		}
		const dir = tempDir('bootstrap');
		try {
			const site = path.join(dir, 'site dir');
			const workspace = path.join(dir, 'work space');
			const extension = path.join(dir, 'extension dir');
			for (const d of [site, workspace, extension]) {
				fs.mkdirSync(d);
			}
			const report = 'import json, os, sys\nprint(json.dumps({"from": __file__, "cwd": os.getcwd(), "argv": sys.argv[1:]}))\n';
			fs.writeFileSync(path.join(site, 'fakecli.py'), report);
			// A workspace file with the same name must not be imported.
			fs.writeFileSync(path.join(workspace, 'fakecli.py'), 'raise SystemExit("workspace code ran")\n');
			fs.writeFileSync(path.join(extension, 'fakecli.py'), 'raise SystemExit("extension-dir code ran")\n');
			const env = cliEnvironment({ ...process.env, PYTHONPATH: site }, '');
			const invocation: Invocation = {
				command: python,
				prefix: ['-c', PYTHON_BOOTSTRAP, workspace, 'fakecli'],
				cwd: extension,
				display: 'python -m fakecli',
			};
			// The extension directory itself is on sys.path only through '' (dropped).
			const outcome = await startInvocation(invocation, 'xrobot', ['-C', workspace, 'describe', '"闪烁"'], env).done;
			assert.ok(outcome.ok, outcome.message ?? outcome.stderr);
			const result = JSON.parse(outcome.stdout);
			assert.strictEqual(fs.realpathSync(path.dirname(result.from)), fs.realpathSync(site));
			assert.strictEqual(fs.realpathSync(result.cwd), fs.realpathSync(workspace));
			assert.deepStrictEqual(result.argv, ['-C', workspace, 'describe', '"闪烁"']);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('the libxr probe needs the package __main__ that only libxr 6.0.0 or later has', async function () {
		// libxr 5.x also has a `libxr` package; finding the package used to pass the check,
		// and the LibXR actions then failed with "'libxr' is a package and cannot be
		// directly executed".
		const python = findPython({ env: process.env });
		if (!python) {
			this.skip();
			return;
		}
		const dir = tempDir('probe');
		try {
			for (const [name, files] of [
				['fakelibxr_old', ['__init__.py']],
				['fakelibxr_new', ['__init__.py', '__main__.py']],
			] as const) {
				fs.mkdirSync(path.join(dir, name));
				for (const file of files) {
					fs.writeFileSync(path.join(dir, name, file), '');
				}
			}
			const env = cliEnvironment({ ...process.env, PYTHONPATH: dir }, '');
			assert.strictEqual(await pythonHasModule(python, 'fakelibxr_old', dir, env), true);
			assert.strictEqual(await pythonHasModule(python, 'fakelibxr_old.__main__', dir, env), false);
			assert.strictEqual(await pythonHasModule(python, 'fakelibxr_new.__main__', dir, env), true);
			assert.strictEqual(await pythonHasModule(python, 'fakelibxr_missing.__main__', dir, env), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

suite('process helpers', () => {
	test('decodeUtf8 joins the bytes before decoding', () => {
		const bytes = Buffer.from('闪烁', 'utf8');
		assert.strictEqual(decodeUtf8([bytes.subarray(0, 1), bytes.subarray(1, 4), bytes.subarray(4)]), '闪烁');
	});

	test('failureMessage prefers the last stderr line that is not a warning', () => {
		assert.strictEqual(failureMessage({ code: 1, stdout: '', stderr: 'warning: a\nboom\n', cancelled: false }, 'xrobot'), 'boom');
		assert.strictEqual(failureMessage({ code: 1, stdout: '', stderr: '警告：a\n出错\n', cancelled: false }, 'xrobot'), '出错');
		assert.strictEqual(failureMessage({ code: 2, stdout: '', stderr: '', cancelled: false }, 'xrobot'), 'xrobot exited with code 2');
		assert.strictEqual(failureMessage({ code: null, stdout: '', stderr: '', cancelled: true }, 'xrobot'), 'xrobot was cancelled');
	});
});
