// The shared `libxr pins` result: one run per refresh, used by the pin layout panel and the
// LibXR tree (the Peripherals group). Reading the state never starts a run.
import * as vscode from 'vscode';
import { getWorkspaceRoot, outputChannel, startQuiet } from './cliHost';
import { libxrArgs, type CliRun } from './cli/xrobotCli';
import { parsePinsOutput, pinsFailureHint, type PinsResult } from './pins/model';
import { detectPinsProject, listIocFiles } from './pins/project';

export type PinsState =
	// No STM32CubeMX .ioc or SysConfig header in the workspace: the pin layout does not apply.
	| { status: 'none' }
	| { status: 'running'; previous?: PinsResult }
	| { status: 'ok'; result: PinsResult }
	// The CLI's own message (or the parse error); `libxr pins` needs a release that has the command.
	| { status: 'error'; message: string };

class PinsService {
	private current: PinsState = { status: 'none' };
	private run: CliRun | undefined;
	private generation = 0;
	private readonly changes = new vscode.EventEmitter<PinsState>();
	readonly onDidChange = this.changes.event;

	get state(): PinsState {
		return this.current;
	}

	private set(state: PinsState): void {
		this.current = state;
		this.changes.fire(state);
	}

	// Runs `libxr pins -d .` (its paths are relative to the workspace root), cancelling a run that
	// is still going. The previous result stays visible while the new one is computed.
	async refresh(): Promise<void> {
		const root = getWorkspaceRoot();
		this.run?.cancel();
		if (!root || !detectPinsProject(root, listIocFiles(root))) {
			this.generation += 1;
			this.set({ status: 'none' });
			return;
		}
		const mine = ++this.generation;
		const previous = this.current.status === 'ok' ? this.current.result : this.current.status === 'running' ? this.current.previous : undefined;
		this.set({ status: 'running', previous });
		const configRel = vscode.workspace.getConfiguration().get<string>('xrobot.libxr.configPath', 'User/libxr_config.yaml').trim().replace(/\\/g, '/') || 'User/libxr_config.yaml';
		const packageName = vscode.workspace.getConfiguration('xrobot.libxr').get<string>('package', '').trim();
		const run = startQuiet('libxr', libxrArgs.pins('.', configRel, packageName || undefined), root);
		this.run = run;
		const outcome = await run.done;
		if (mine !== this.generation || outcome.cancelled) {
			return;
		}
		if (!outcome.ok) {
			outputChannel.appendLine(`[pins] ${run.commandLine}: ${outcome.message ?? ''}`);
			this.set({ status: 'error', message: pinsFailureHint(outcome.message ?? 'libxr pins failed') });
			return;
		}
		const parsed = parsePinsOutput(outcome.stdout);
		if (!parsed.ok) {
			outputChannel.appendLine(`[pins] ${run.commandLine}: ${parsed.error}`);
			this.set({ status: 'error', message: parsed.error });
			return;
		}
		this.set({ status: 'ok', result: parsed.result });
	}
}

export const pinsService = new PinsService();
