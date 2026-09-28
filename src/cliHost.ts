// VS Code side of the CLI adapter: settings, the "XRobot" output channel and the shared
// `xrobot describe` result.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	cliEnvironment,
	configHash,
	resolveInvocation,
	startInvocation,
	xrobotArgs,
	type CliOutcome,
	type CliRun,
	type Invocation,
} from './cli/xrobotCli';
import { parseDescribeOutput, type DescribeResult } from './providers/describeModel';

export const outputChannel = vscode.window.createOutputChannel('XRobot');

let extensionDir: string | undefined;

export function initCliHost(context: vscode.ExtensionContext): void {
	extensionDir = context.extensionPath;
	context.subscriptions.push(outputChannel);
}

export function getWorkspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// An XRobot BSP is the directory containing Modules/modules.yaml (the CLI's own rule).
export function isXrobotBsp(root: string): boolean {
	return fs.existsSync(path.join(root, 'Modules', 'modules.yaml'));
}

export function cliEnv(): NodeJS.ProcessEnv {
	const extraPath = vscode.workspace.getConfiguration('xrobot.cli').get<string>('extraPath', '');
	return cliEnvironment(process.env, extraPath);
}

export function invocationFor(tool: string, root: string, env: NodeJS.ProcessEnv = cliEnv()): Invocation | undefined {
	if (!extensionDir) {
		throw new Error('XRobot CLI host used before activation');
	}
	return resolveInvocation(tool, {
		env,
		python: vscode.workspace.getConfiguration('xrobot.cli').get<string>('pythonPath', ''),
		extensionDir,
		workspaceRoot: root,
	});
}

// Runs a CLI without echoing it (queries such as `xrobot describe`, `xrobot source get`).
export function startQuiet(tool: string, args: string[], root: string): CliRun {
	const env = cliEnv();
	return startInvocation(invocationFor(tool, root, env), tool, args, env);
}

export type RunOptions = {
	// Bring the output channel to front (explicit user actions); background runs only log.
	reveal?: boolean;
};

// Runs a CLI with its output streamed to the "XRobot" channel; resolves with the outcome.
export async function runLogged(tool: string, args: string[], root: string, options: RunOptions = {}): Promise<CliOutcome> {
	const env = cliEnv();
	const invocation = invocationFor(tool, root, env);
	const run = startInvocation(invocation, tool, args, env, {
		onStdout: (text) => outputChannel.append(text),
		onStderr: (text) => outputChannel.append(text),
	});
	outputChannel.appendLine(`$ ${run.commandLine}`);
	outputChannel.appendLine(`cwd: ${invocation?.cwd ?? root}`);
	outputChannel.appendLine('----');
	if (options.reveal) {
		outputChannel.show(true);
	}
	const outcome = await run.done;
	if (outcome.ok) {
		outputChannel.appendLine('[exit] 0');
	} else {
		outputChannel.appendLine(`[failed] ${outcome.message ?? ''}${outcome.code === null ? '' : ` (exit ${outcome.code})`}`);
	}
	outputChannel.appendLine('');
	return outcome;
}

// Shows a failed outcome with the CLI's own message; returns outcome.ok.
export function reportOutcome(label: string, outcome: CliOutcome): boolean {
	if (outcome.ok || outcome.cancelled) {
		return outcome.ok;
	}
	void vscode.window.showErrorMessage(`${label} failed: ${outcome.message ?? 'see "XRobot" output'}`, 'Show Output').then((choice) => {
		if (choice) {
			outputChannel.show(true);
		}
	});
	return false;
}

// ---------------------------------------------------------------------------------------
// Shared `xrobot describe` result: one run per refresh, used by the tree and the commands.

export type DescribeOutcome =
	| { ok: true; value: DescribeResult; hashes: Map<string, string> }
	| { ok: false; error: string; cancelled?: boolean };

// LF-normalized sha256 of every application config, taken *before* describe reads them:
// an edit passes it as --if-match, so a file changed after it was shown is not
// overwritten (the CLI refuses and the view reloads).
function hashConfigs(root: string): Map<string, string> {
	const hashes = new Map<string, string>();
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(abs);
			} else if (entry.isFile() && entry.name.endsWith('.yaml')) {
				try {
					hashes.set(path.relative(root, abs).split(path.sep).join('/'), configHash(fs.readFileSync(abs)));
				} catch {
					// Unreadable now; describe reports it.
				}
			}
		}
	};
	walk(path.join(root, 'User'));
	return hashes;
}

class DescribeService {
	private root: string | undefined;
	private pending: Promise<DescribeOutcome> | undefined;
	private cancelRun: (() => void) | undefined;

	invalidate(): void {
		this.cancelRun?.();
		this.root = undefined;
		this.pending = undefined;
		this.cancelRun = undefined;
	}

	get(root: string): Promise<DescribeOutcome> {
		if (this.pending && this.root === root) {
			return this.pending;
		}
		this.invalidate();
		const hashes = hashConfigs(root);
		const args = xrobotArgs.describe(root);
		const run = startQuiet('xrobot', args, root);
		this.root = root;
		this.cancelRun = run.cancel;
		const pending = run.done.then((outcome): DescribeOutcome => {
			if (outcome.cancelled) {
				return { ok: false, error: 'cancelled', cancelled: true };
			}
			if (!outcome.ok) {
				outputChannel.appendLine(`[describe] ${run.commandLine}: ${outcome.message ?? ''}`);
				return { ok: false, error: outcome.message ?? 'xrobot describe failed' };
			}
			const parsed = parseDescribeOutput(outcome.stdout);
			if (!parsed.ok) {
				outputChannel.appendLine(`[describe] ${run.commandLine}: ${parsed.error}`);
				return parsed;
			}
			return { ok: true, value: parsed.value, hashes };
		});
		this.pending = pending;
		void vscode.window.withProgress({ location: { viewId: 'xrobot.xrobotView' } }, () => pending);
		return pending;
	}

	// Resolves with a run that was not cancelled by a later refresh.
	async current(root: string): Promise<DescribeOutcome> {
		for (;;) {
			const outcome = await this.get(root);
			if (outcome.ok || !outcome.cancelled) {
				return outcome;
			}
		}
	}
}

export const describeService = new DescribeService();

export function configAbsolute(root: string, rel: string): string {
	return path.resolve(root, rel);
}
