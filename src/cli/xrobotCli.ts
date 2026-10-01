// Adapter for the `xrobot` CLI (XRobot 1.0) and the LibXR console scripts.
// No `vscode` import: argument building, tool resolution, decoding and exit-code handling
// are unit-tested with a fake executable.
//
// Every xrobot call names the BSP root with `-C <absolute root>` and passes absolute file
// paths, so the result does not depend on the process working directory (the Python
// fallback below starts in the extension directory).
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { failureMessage, findExecutable, pathKey, runProcess, splitPathList, type ProcessResult } from './process';

export type Invocation = {
	command: string;
	// Arguments placed before the tool's own arguments (the Python bootstrap).
	prefix: string[];
	cwd: string;
	// How the command is shown in the output channel.
	display: string;
};

// Python modules run when a console script is not on PATH (the package is installed for
// an interpreter whose Scripts/bin directory is not on PATH).
export const PYTHON_MODULES: Record<string, string> = {
	xrobot: 'xrobot.cli',
	// The package runs its __main__ (libxr 6.0.0 or later).
	libxr: 'libxr',
};

// Started with the extension directory as working directory: `python -c` puts the
// working directory first on sys.path, so starting in the workspace could import Python
// code from the workspace. The bootstrap drops that entry, then changes into the
// workspace (the LibXR tools take workspace-relative paths) and runs the module as
// `python -m` would.
export const PYTHON_BOOTSTRAP = [
	'import os, runpy, sys',
	"sys.path[:] = [p for p in sys.path if p not in ('', '.')]",
	'workdir, module = sys.argv[1], sys.argv[2]',
	'sys.argv = [module] + sys.argv[3:]',
	'os.chdir(workdir)',
	"runpy.run_module(module, run_name='__main__', alter_sys=True)",
].join('\n');

const PYTHON_NAMES: Record<string, string[]> = {
	win32: ['python', 'py', 'python3'],
	default: ['python3', 'python'],
};

export type ResolveOptions = {
	env: NodeJS.ProcessEnv;
	// `xrobot.cli.pythonPath`: interpreter name or path; empty = search PATH.
	python?: string;
	extensionDir: string;
	workspaceRoot: string;
	platform?: NodeJS.Platform;
};

export function findPython(options: Pick<ResolveOptions, 'env' | 'python' | 'platform'>): string | undefined {
	const platform = options.platform ?? process.platform;
	const configured = options.python?.trim();
	if (configured) {
		return findExecutable(configured, options.env, platform);
	}
	for (const name of PYTHON_NAMES[platform] ?? PYTHON_NAMES.default) {
		const found = findExecutable(name, options.env, platform);
		if (found) {
			return found;
		}
	}
	return undefined;
}

export function pythonInvocation(python: string, module: string, extensionDir: string, workspaceRoot: string): Invocation {
	return {
		command: python,
		prefix: ['-c', PYTHON_BOOTSTRAP, workspaceRoot, module],
		cwd: extensionDir,
		display: `${python} -m ${module}`,
	};
}

// The console script on PATH, else its Python module with the configured/detected
// interpreter, else undefined (the tool is not installed where the extension can see it).
export function resolveInvocation(tool: string, options: ResolveOptions): Invocation | undefined {
	const platform = options.platform ?? process.platform;
	const executable = findExecutable(tool, options.env, platform);
	if (executable) {
		return { command: executable, prefix: [], cwd: options.workspaceRoot, display: tool };
	}
	const module = PYTHON_MODULES[tool];
	const python = module ? findPython(options) : undefined;
	if (!module || !python) {
		return undefined;
	}
	return pythonInvocation(python, module, options.extensionDir, options.workspaceRoot);
}

// CLI environment: PATH gains the pip per-user script directories (pip install --user
// puts console scripts there without adding them to PATH) and `xrobot.cli.extraPath`.
// PYTHONIOENCODING=utf-8 makes Python write stdout/stderr as UTF-8 on every platform
// (a Chinese Windows console code page is GBK); the output is decoded as UTF-8.
// XR_LANG follows the VS Code display language unless the user set it, so the messages the
// view shows are Chinese in a Chinese VS Code and English otherwise.
export function cliEnvironment(
	base: NodeJS.ProcessEnv,
	extraPath: string,
	platform: NodeJS.Platform = process.platform,
	displayLanguage?: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	if (displayLanguage && !env.XR_LANG) {
		env.XR_LANG = displayLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en';
	}
	const key = pathKey(env);
	const sep = platform === 'win32' ? ';' : ':';
	const entries = [
		...splitPathList(env[key] ?? '', platform),
		...userScriptDirectories(env, platform),
		...splitPathList(extraPath.trim(), platform),
	];
	const seen = new Set<string>();
	env[key] = entries
		.filter((entry) => {
			const id = platform === 'win32' ? entry.toLowerCase() : entry;
			if (seen.has(id)) {
				return false;
			}
			seen.add(id);
			return true;
		})
		.join(sep);
	env.PYTHONIOENCODING = 'utf-8';
	return env;
}

export function userScriptDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
	const pathApi = platform === 'win32' ? path.win32 : path.posix;
	const dirs: string[] = [];
	if (env.PYTHONUSERBASE) {
		dirs.push(pathApi.join(env.PYTHONUSERBASE, platform === 'win32' ? 'Scripts' : 'bin'));
	}
	if (platform === 'win32') {
		if (env.APPDATA) {
			const pythonRoot = pathApi.join(env.APPDATA, 'Python');
			try {
				for (const entry of fs.readdirSync(pythonRoot, { withFileTypes: true })) {
					if (entry.isDirectory() && /^Python\d+$/i.test(entry.name)) {
						dirs.push(pathApi.join(pythonRoot, entry.name, 'Scripts'));
					}
				}
			} catch {
				// No per-user Python installation.
			}
		}
	} else if (env.HOME) {
		dirs.push(pathApi.join(env.HOME, '.local', 'bin'));
	}
	return dirs;
}

// ---------------------------------------------------------------------------------------
// Argument builders. Each value is one argv element; paths are absolute.

export type SetupMode = { kind: 'plain' } | { kind: 'frozen' } | { kind: 'update'; modules?: string[] };

export const xrobotArgs = {
	init: (root: string): string[] => ['-C', root, 'init'],
	describe: (root: string, config?: string): string[] => ['-C', root, 'describe', ...(config ? ['-c', config] : [])],
	gen: (root: string, config?: string): string[] => ['-C', root, 'gen', ...(config ? ['-c', config] : [])],
	setup: (root: string, mode: SetupMode = { kind: 'plain' }): string[] => {
		const args = ['-C', root, 'setup'];
		if (mode.kind === 'frozen') {
			args.push('--frozen');
		} else if (mode.kind === 'update') {
			args.push('--update', ...(mode.modules ?? []));
		}
		return args;
	},
	format: (root: string, check: boolean): string[] => ['-C', root, 'format', ...(check ? ['--check'] : [])],
	instanceAdd: (root: string, config: string, module: string, id?: string): string[] => [
		'-C', root, 'instance', '-c', config, 'add', module, ...(id ? ['--id', id] : []),
	],
	// `value` is passed as JSON (`--json`): its strings are C++ text, as `xrobot describe` reports them.
	instanceSet: (root: string, config: string, id: string, valuePath: string, value: unknown, ifMatch?: string): string[] => [
		'-C', root, 'instance', '-c', config, 'set', '--json', id, valuePath, JSON.stringify(value), ...(ifMatch ? ['--if-match', ifMatch] : []),
	],
	instanceRemove: (root: string, config: string, id: string): string[] => ['-C', root, 'instance', '-c', config, 'remove', id],
	instanceRename: (root: string, config: string, id: string, newId: string): string[] => [
		'-C', root, 'instance', '-c', config, 'rename', id, newId,
	],
	moduleAdd: (root: string, request: string): string[] => ['-C', root, 'module', 'add', request],
	moduleRemove: (root: string, identity: string): string[] => ['-C', root, 'module', 'remove', identity],
	// `xrobot source` reads Modules/sources.yaml relative to the working directory by
	// default; the path is passed explicitly (before the sub-command, where the CLI takes it).
	source: (root: string, sourcesYaml: string, rest: string[]): string[] => ['-C', root, 'source', '--sources', sourcesYaml, ...rest],
	newModule: (options: NewModuleOptions): string[] => {
		const args = ['new-module', options.name];
		if (options.description) {
			args.push('--desc', options.description);
		}
		for (const declaration of options.constructorParameters) {
			args.push('--constructor', declaration);
		}
		for (const declaration of options.templateParameters) {
			args.push('--template', declaration);
		}
		for (const value of options.templateArguments ?? []) {
			args.push('--template-arg', value);
		}
		for (const include of options.includes ?? []) {
			args.push('--include', include);
		}
		for (const request of options.depends) {
			args.push('--depends', request);
		}
		args.push('--out', options.outDir);
		return args;
	},
	version: (): string[] => ['--version'],
};

export type NewModuleOptions = {
	name: string;
	description: string;
	constructorParameters: string[];
	templateParameters: string[];
	// Template arguments the Module CI compiles the constructor probe with.
	templateArguments?: string[];
	includes?: string[];
	depends: string[];
	outDir: string;
};

// `instance set` PATH: `template_args[n]`, `args.<param>`, `args.<param>.<field>...`,
// `[n]` for list elements.
export type PathSegment = string | number;

export function valuePath(root: 'args' | 'template_args', segments: PathSegment[]): string {
	let text = root;
	for (const segment of segments) {
		if (typeof segment === 'number') {
			text += `[${segment}]`;
		} else {
			if (!isIdentifier(segment)) {
				throw new Error(`"${segment}" cannot be addressed by xrobot instance set (not an identifier)`);
			}
			text += `.${segment}`;
		}
	}
	return text;
}

export function isIdentifier(value: string): boolean {
	return /^[A-Za-z_][A-Za-z_0-9]*$/.test(value);
}

// `--if-match` value: sha256 of the file bytes with CRLF normalized to LF.
export function configHash(bytes: Buffer): string {
	const normalized: number[] = [];
	for (let i = 0; i < bytes.length; i += 1) {
		if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) {
			continue;
		}
		normalized.push(bytes[i]);
	}
	return crypto.createHash('sha256').update(Buffer.from(normalized)).digest('hex');
}

// Display-only rendering of a command line (the process gets the raw argv).
export function formatCommandLine(command: string, args: string[]): string {
	const quote = (arg: string): string =>
		/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\])/g, '\\$1').replace(/\n/g, '\\n')}"`;
	return [command, ...args.map(quote)].join(' ');
}

// ---------------------------------------------------------------------------------------
// Running.

export type CliOutcome = {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	cancelled: boolean;
	// False when neither the console script nor its Python module could be started.
	found: boolean;
	// Failure reason (the CLI's stderr message); undefined when ok.
	message?: string;
};

export type CliHandlers = { onStdout?: (text: string) => void; onStderr?: (text: string) => void };

export type CliRun = { done: Promise<CliOutcome>; cancel: () => void; commandLine: string };

export function outcomeOf(result: ProcessResult, display: string): CliOutcome {
	const ok = !result.error && !result.cancelled && result.code === 0;
	return {
		ok,
		code: result.code,
		stdout: result.stdout,
		stderr: result.stderr,
		cancelled: result.cancelled,
		found: result.error?.code !== 'ENOENT',
		message: ok ? undefined : failureMessage(result, display),
	};
}

export function startInvocation(
	invocation: Invocation | undefined,
	tool: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	handlers?: CliHandlers,
): CliRun {
	if (!invocation) {
		return {
			commandLine: formatCommandLine(tool, args),
			cancel: () => undefined,
			done: Promise.resolve({
				ok: false,
				code: null,
				stdout: '',
				stderr: '',
				cancelled: false,
				found: false,
				message: `${tool} was not found on PATH and no Python interpreter with its package was found; ` +
					'install it (pip install ' + (tool === 'xrobot' ? 'xrobot' : 'libxr') + ') or set xrobot.cli.extraPath / xrobot.cli.pythonPath',
			}),
		};
	}
	const run = runProcess(invocation.command, [...invocation.prefix, ...args], { cwd: invocation.cwd, env, ...handlers });
	return {
		commandLine: formatCommandLine(invocation.display, args),
		cancel: run.cancel,
		done: run.done.then((result) => outcomeOf(result, invocation.display)),
	};
}
