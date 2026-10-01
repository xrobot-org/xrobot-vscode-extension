// XRobot commands. Every change of an application config goes through
// `xrobot instance add|set|remove|rename`; Module requests through `xrobot module
// add|remove`; the product is selected with `xrobot gen -c`. A command started without
// its target (e.g. from the command palette) asks for it; cancelling writes nothing.
import * as vscode from 'vscode';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseLsRemote, type RemoteRefs } from '../cli/gitRefs';
import { findExecutable, runProcess } from '../cli/process';
import { isIdentifier, xrobotArgs } from '../cli/xrobotCli';
import {
	cliEnv,
	configAbsolute,
	describeService,
	getWorkspaceRoot,
	invocationFor,
	isXrobotBsp,
	outputChannel,
	reportOutcome,
	runLogged,
	startQuiet,
} from '../cliHost';
import { shouldRegenerate, type DescribeInstance, type DescribeResult } from '../providers/describeModel';
import { editInstanceInteractively, type InstanceEditTarget } from '../providers/instanceEditor';
import { detectIocFiles } from '../providers/viewProviders';
import { editSource, isProtectedSourceUrl, readModuleRequests, readSources, type ModuleRequest, type SourceEdit } from '../providers/workspaceFiles';
import { REMOTE_VERSION_DEFAULT_LABEL } from '../uiText';

type Refresh = () => void;

type LoadedState = { root: string; describe: DescribeResult; hashes: Map<string, string> };

function requireBsp(): string | undefined {
	const root = getWorkspaceRoot();
	if (!root) {
		void vscode.window.showInformationMessage('Open a workspace folder first.');
		return undefined;
	}
	if (!isXrobotBsp(root)) {
		void vscode.window.showInformationMessage('This workspace is not an XRobot BSP (no Modules/modules.yaml).');
		return undefined;
	}
	return root;
}

async function loadState(): Promise<LoadedState | undefined> {
	const root = requireBsp();
	if (!root) {
		return undefined;
	}
	const outcome = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: 'XRobot: xrobot describe' },
		() => describeService.current(root),
	);
	if (!outcome.ok) {
		void vscode.window.showErrorMessage(`xrobot describe failed: ${outcome.error}`);
		return undefined;
	}
	return { root, describe: outcome.value, hashes: outcome.hashes };
}

// After a config edit: reload, and regenerate the header when describe reports that the
// selected product generates without error (a config with unfilled values does not).
async function reloadAndRegenerate(root: string, refresh: Refresh): Promise<void> {
	refresh();
	const outcome = await describeService.current(root);
	if (!outcome.ok || !shouldRegenerate(outcome.value)) {
		return;
	}
	const gen = await runLogged('xrobot', xrobotArgs.gen(root, configAbsolute(root, outcome.value.config)), root);
	reportOutcome('xrobot gen', gen);
	refresh();
}

function lastLine(text: string): string | undefined {
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.pop();
}

async function pickInstance(describe: DescribeResult, placeHolder: string): Promise<DescribeInstance | undefined> {
	if (describe.instances.length === 0) {
		void vscode.window.showInformationMessage(`No instances in ${describe.config}.`);
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		describe.instances.map((instance) => ({ label: instance.id, description: instance.module, instance })),
		{ placeHolder, matchOnDescription: true },
	);
	return picked?.instance;
}

// ---------------------------------------------------------------------------------------
// Instances

export async function addModuleInstance(refresh: Refresh): Promise<void> {
	const state = await loadState();
	if (!state) {
		return;
	}
	const { root, describe } = state;
	const modules = Object.values(describe.modules)
		.filter((m) => m.standalone)
		.sort((a, b) => a.id.localeCompare(b.id));
	if (modules.length === 0) {
		void vscode.window.showInformationMessage('No instantiable Module in xrobot.lock.');
		return;
	}
	const picked = await vscode.window.showQuickPick(
		modules.map((m) => ({ label: m.id, description: m.class, detail: m.error ? `interface error: ${m.error}` : undefined, module: m })),
		{ placeHolder: `Module to instantiate in ${describe.config}`, matchOnDescription: true },
	);
	if (!picked) {
		return;
	}
	const taken = new Set(describe.instances.map((i) => i.id));
	const id = await vscode.window.showInputBox({
		prompt: `Instance id for ${picked.module.id} (empty: the CLI assigns ${picked.module.class.toLowerCase()}_<n>)`,
		validateInput: (value) => {
			const trimmed = value.trim();
			if (!trimmed) {
				return undefined;
			}
			if (!isIdentifier(trimmed)) {
				return 'Instance id must be a C++ identifier';
			}
			return taken.has(trimmed) ? `Instance id ${trimmed} already exists` : undefined;
		},
	});
	if (id === undefined) {
		return;
	}
	const outcome = await runLogged(
		'xrobot',
		xrobotArgs.instanceAdd(root, configAbsolute(root, describe.config), picked.module.id, id.trim() || undefined),
		root,
	);
	if (reportOutcome('xrobot instance add', outcome)) {
		const message = lastLine(outcome.stdout);
		if (message) {
			void vscode.window.showInformationMessage(message);
		}
	}
	await reloadAndRegenerate(root, refresh);
}

export async function editModuleInstance(refresh: Refresh, instanceId?: string, target?: InstanceEditTarget): Promise<void> {
	const state = await loadState();
	if (!state) {
		return;
	}
	const { root, describe, hashes } = state;
	const instance =
		instanceId !== undefined
			? describe.instances.find((i) => i.id === instanceId)
			: await pickInstance(describe, 'Instance to edit');
	if (!instance) {
		if (instanceId !== undefined) {
			void vscode.window.showWarningMessage(`${instanceId} is no longer in ${describe.config}.`);
		}
		return;
	}
	let edit;
	try {
		edit = await editInstanceInteractively(describe, instance, target);
	} catch (error) {
		void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
		return;
	}
	if (!edit) {
		return;
	}
	const config = configAbsolute(root, describe.config);
	const args =
		edit.kind === 'rename'
			? xrobotArgs.instanceRename(root, config, instance.id, edit.newId)
			: xrobotArgs.instanceSet(root, config, instance.id, edit.path, edit.value, hashes.get(describe.config));
	const outcome = await runLogged('xrobot', args, root);
	if (!reportOutcome(edit.kind === 'rename' ? 'xrobot instance rename' : 'xrobot instance set', outcome)) {
		refresh();
		return;
	}
	if (edit.kind === 'set' && edit.added && edit.added.length > 0) {
		void vscode.window.showInformationMessage(
			`${instance.id}: new parameters ${edit.added.join(', ')} take their source defaults; null means not filled in.`,
		);
	}
	await reloadAndRegenerate(root, refresh);
}

export async function deleteModuleInstance(refresh: Refresh, instanceId?: string): Promise<void> {
	const state = await loadState();
	if (!state) {
		return;
	}
	const { root, describe } = state;
	const id = instanceId ?? (await pickInstance(describe, 'Instance to delete'))?.id;
	if (!id) {
		return;
	}
	const confirmed = await vscode.window.showWarningMessage(`Remove instance ${id} from ${describe.config}?`, { modal: true }, 'Remove');
	if (confirmed !== 'Remove') {
		return;
	}
	const outcome = await runLogged('xrobot', xrobotArgs.instanceRemove(root, configAbsolute(root, describe.config), id), root);
	if (!reportOutcome('xrobot instance remove', outcome)) {
		refresh();
		return;
	}
	await reloadAndRegenerate(root, refresh);
}

// ---------------------------------------------------------------------------------------
// Product selection: the product is the config User/xrobot_main.hpp was generated for.

export async function selectProduct(refresh: Refresh, config?: string): Promise<void> {
	const state = await loadState();
	if (!state) {
		return;
	}
	const { root, describe } = state;
	let chosen = config;
	if (chosen === undefined) {
		const picked = await vscode.window.showQuickPick(
			describe.configs.map((c) => ({ label: c, description: c === describe.selected ? 'selected' : undefined })),
			{ placeHolder: 'Product to build (runs xrobot gen -c <config>)' },
		);
		chosen = picked?.label;
	}
	if (!chosen || chosen === describe.selected) {
		return;
	}
	const target = chosen;
	const outcome = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `xrobot gen -c ${target}` },
		() => runLogged('xrobot', xrobotArgs.gen(root, configAbsolute(root, target)), root),
	);
	if (reportOutcome(`Selecting ${target}`, outcome)) {
		void vscode.window.showInformationMessage(lastLine(outcome.stdout) ?? `Selected ${target}`);
	}
	refresh();
}

// ---------------------------------------------------------------------------------------
// Module requests (Modules/modules.yaml)

function readRequests(root: string): ModuleRequest[] | undefined {
	const result = readModuleRequests(path.join(root, 'Modules', 'modules.yaml'));
	if (!result.ok) {
		void vscode.window.showErrorMessage(`Modules/modules.yaml: ${result.error}`);
		return undefined;
	}
	return result.value;
}

async function pickRequest(root: string, placeHolder: string): Promise<ModuleRequest | undefined> {
	const requests = readRequests(root);
	if (!requests) {
		return undefined;
	}
	if (requests.length === 0) {
		void vscode.window.showInformationMessage('Modules/modules.yaml requests no Module.');
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		requests.map((request) => ({ label: request.id, description: request.ref ?? REMOTE_VERSION_DEFAULT_LABEL, request })),
		{ placeHolder },
	);
	return picked?.request;
}

function sourcesYaml(root: string): string {
	return path.join(root, 'Modules', 'sources.yaml');
}

async function catalogModules(root: string): Promise<string[]> {
	const outcome = await startQuiet('xrobot', xrobotArgs.source(root, sourcesYaml(root), ['list', '--type', 'module']), root).done;
	if (!outcome.ok) {
		outputChannel.appendLine(`[source list] ${outcome.message ?? ''}`);
		return [];
	}
	// Lines: `<owner/Repo> [module] <repository url>`.
	return outcome.stdout
		.split(/\r?\n/)
		.map((line) => line.trim().split(/\s+/)[0])
		.filter((id) => /^[^/\s]+\/[^/\s]+$/.test(id));
}

const REQUEST_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*(@[^\s@-][^\s@]*)?$/;

export async function addRepo(refresh: Refresh): Promise<void> {
	const root = requireBsp();
	if (!root) {
		return;
	}
	const requested = new Set((readRequests(root) ?? []).map((r) => r.id.toLowerCase()));
	const candidates = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: 'XRobot: xrobot source list' },
		() => catalogModules(root),
	);
	const manual = '$(edit) Enter owner/Repo[@ref]…';
	const picked = await vscode.window.showQuickPick(
		[...candidates.filter((c) => !requested.has(c.toLowerCase())).map((label) => ({ label })), { label: manual }],
		{ placeHolder: 'Module to request (from the catalogs in Modules/sources.yaml)' },
	);
	if (!picked) {
		return;
	}
	let request = picked.label;
	if (request === manual) {
		const input = await vscode.window.showInputBox({
			prompt: 'Module request',
			placeHolder: 'xrobot-org/BlinkLED or xrobot-org/BlinkLED@refs/tags/v1.0.0',
			validateInput: (value) => (REQUEST_PATTERN.test(value.trim()) ? undefined : 'Expected owner/Repo or owner/Repo@ref'),
		});
		if (!input) {
			return;
		}
		request = input.trim();
	}
	const outcome = await runLogged('xrobot', xrobotArgs.moduleAdd(root, request), root);
	if (reportOutcome('xrobot module add', outcome)) {
		void vscode.window.showInformationMessage(lastLine(outcome.stdout) ?? `Added ${request}`);
	}
	refresh();
}

export async function deleteRepo(refresh: Refresh, id?: string): Promise<void> {
	const root = requireBsp();
	if (!root) {
		return;
	}
	const identity = id ?? (await pickRequest(root, 'Module request to remove'))?.id;
	if (!identity) {
		return;
	}
	const confirmed = await vscode.window.showWarningMessage(
		`Remove the request for ${identity} from Modules/modules.yaml?`,
		{ modal: true },
		'Remove',
	);
	if (confirmed !== 'Remove') {
		return;
	}
	const outcome = await runLogged('xrobot', xrobotArgs.moduleRemove(root, identity), root);
	if (reportOutcome('xrobot module remove', outcome)) {
		void vscode.window.showInformationMessage(lastLine(outcome.stdout) ?? `Removed ${identity}`);
	}
	refresh();
}

type RefPick = vscode.QuickPickItem & { ref: string };

// The Module's repository as the source catalogs resolve it (`xrobot source get`).
async function repositoryOf(root: string, id: string): Promise<string | undefined> {
	const outcome = await startQuiet('xrobot', xrobotArgs.source(root, sourcesYaml(root), ['get', id]), root).done;
	if (!reportOutcome(`xrobot source get ${id}`, outcome)) {
		return undefined;
	}
	let record: unknown;
	try {
		record = parseYaml(outcome.stdout);
	} catch {
		record = undefined;
	}
	const repo = record && typeof record === 'object' ? (record as Record<string, unknown>).repo : undefined;
	if (typeof repo !== 'string' || !repo) {
		void vscode.window.showErrorMessage(`xrobot source get ${id} printed no repository.`);
		return undefined;
	}
	return repo;
}

async function remoteRefs(root: string, repo: string): Promise<RemoteRefs | undefined> {
	const env = cliEnv();
	const git = findExecutable('git', env);
	if (!git) {
		void vscode.window.showErrorMessage('git was not found on PATH.');
		return undefined;
	}
	const result = await runProcess(git, ['ls-remote', '--heads', '--tags', repo], { cwd: root, env }).done;
	if (result.code !== 0) {
		void vscode.window.showErrorMessage(`git ls-remote ${repo} failed: ${result.error?.message ?? result.stderr.trim()}`);
		return undefined;
	}
	return parseLsRemote(result.stdout);
}

// Changing a request's ref is `xrobot module remove` + `xrobot module add id@ref`; if
// the add fails the previous request is added back.
export async function editRepoVersion(refresh: Refresh, id?: string): Promise<void> {
	const root = requireBsp();
	if (!root) {
		return;
	}
	const requests = readRequests(root);
	const request = id !== undefined ? requests?.find((r) => r.id === id) : await pickRequest(root, 'Module request to change');
	if (!request) {
		if (id !== undefined && requests) {
			void vscode.window.showWarningMessage(`${id} is no longer requested in Modules/modules.yaml.`);
		}
		return;
	}
	if (!request.plain) {
		void vscode.window.showInformationMessage(
			`${request.id} is written as a mapping in Modules/modules.yaml; change its ref in the file.`,
		);
		return;
	}
	const refs = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Reading refs of ${request.id}` },
		async () => {
			const repo = await repositoryOf(root, request.id);
			return repo ? remoteRefs(root, repo) : undefined;
		},
	);
	if (!refs) {
		return;
	}
	const current = request.ref;
	const mark = (ref: string): string | undefined => (ref === current ? 'current' : undefined);
	const items: RefPick[] = [
		{ label: 'same-or-dev', description: mark('same-or-dev'), detail: 'the BSP branch of the same name, else dev', ref: 'same-or-dev' },
		{ label: 'same', description: mark('same'), detail: 'the BSP branch/tag of the same name', ref: 'same' },
		...refs.branches.map((b) => ({ label: `$(git-branch) ${b}`, description: mark(`refs/heads/${b}`), ref: `refs/heads/${b}` })),
		...refs.tags.map((t) => ({ label: `$(tag) ${t}`, description: mark(`refs/tags/${t}`), ref: `refs/tags/${t}` })),
	];
	const picked = await vscode.window.showQuickPick(items, { placeHolder: `Ref for ${request.id} (current: ${current ?? REMOTE_VERSION_DEFAULT_LABEL})` });
	if (!picked || picked.ref === current) {
		return;
	}
	const previous = current ? `${request.id}@${current}` : request.id;
	const removed = await runLogged('xrobot', xrobotArgs.moduleRemove(root, request.id), root);
	if (!reportOutcome('xrobot module remove', removed)) {
		refresh();
		return;
	}
	const added = await runLogged('xrobot', xrobotArgs.moduleAdd(root, `${request.id}@${picked.ref}`), root);
	if (!reportOutcome('xrobot module add', added)) {
		// `xrobot module add` writes a request without a ref as `@same-or-dev`.
		const restored = await runLogged('xrobot', xrobotArgs.moduleAdd(root, previous), root);
		if (reportOutcome(`restoring ${previous}`, restored) && !current) {
			void vscode.window.showWarningMessage(`${request.id} was restored as ${request.id}@same-or-dev (it had no ref).`);
		}
		refresh();
		return;
	}
	void vscode.window.showInformationMessage(lastLine(added.stdout) ?? `${request.id} now requests ${picked.ref}`);
	refresh();
}

// ---------------------------------------------------------------------------------------
// Sources (Modules/sources.yaml)

async function pickEditableSource(root: string, placeHolder: string): Promise<string | undefined> {
	const result = readSources(sourcesYaml(root));
	if (!result.ok) {
		void vscode.window.showErrorMessage(`Modules/sources.yaml: ${result.error}`);
		return undefined;
	}
	const editable = result.value.filter((s) => !s.protected);
	if (editable.length === 0) {
		void vscode.window.showInformationMessage('Modules/sources.yaml has no source that can be changed (the official source is read-only).');
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		editable.map((s) => ({ label: s.url, description: `priority ${s.priority}` })),
		{ placeHolder },
	);
	return picked?.label;
}

// The source to edit: the tree passes its URL, the command palette asks. The official
// catalog is refused before any prompt.
async function targetSource(root: string, url: string | undefined, placeHolder: string): Promise<string | undefined> {
	if (url !== undefined && isProtectedSourceUrl(url)) {
		void vscode.window.showErrorMessage(`${url} is the official source and cannot be changed`);
		return undefined;
	}
	return url ?? pickEditableSource(root, placeHolder);
}

const PRIORITY_PATTERN = /^-?\d+$/;

export async function addSource(refresh: Refresh): Promise<void> {
	const root = requireBsp();
	if (!root) {
		return;
	}
	const existing = readSources(sourcesYaml(root));
	const known = new Set(existing.ok ? existing.value.map((s) => s.url) : []);
	const url = await vscode.window.showInputBox({
		prompt: 'Catalog URL or path of an index.yaml (relative paths are relative to Modules/sources.yaml)',
		validateInput: (value) => (!value.trim() ? 'Enter a URL or path' : known.has(value.trim()) ? 'Already listed' : undefined),
	});
	if (!url) {
		return;
	}
	const priority = await vscode.window.showInputBox({
		prompt: 'Priority (integer; lower is preferred)',
		value: '0',
		validateInput: (value) => (PRIORITY_PATTERN.test(value.trim()) ? undefined : 'Priority must be an integer'),
	});
	if (priority === undefined) {
		return;
	}
	const outcome = await runLogged(
		'xrobot',
		xrobotArgs.source(root, sourcesYaml(root), ['add-source', url.trim(), '--priority', priority.trim()]),
		root,
	);
	reportOutcome('xrobot source add-source', outcome);
	refresh();
}

async function applySourceEdit(root: string, url: string, edit: SourceEdit, refresh: Refresh): Promise<void> {
	try {
		editSource(sourcesYaml(root), url, edit);
	} catch (error) {
		void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
	}
	refresh();
}

export async function editSourceUrl(refresh: Refresh, url?: string): Promise<void> {
	const root = requireBsp();
	const source = root && (await targetSource(root, url, 'Source to change'));
	if (!root || !source) {
		return;
	}
	const next = await vscode.window.showInputBox({
		prompt: 'Catalog URL or path',
		value: source,
		validateInput: (value) => (value.trim() ? undefined : 'Enter a URL or path'),
	});
	if (!next || next.trim() === source) {
		return;
	}
	await applySourceEdit(root, source, { kind: 'url', url: next.trim() }, refresh);
}

export async function editSourcePriority(refresh: Refresh, url?: string): Promise<void> {
	const root = requireBsp();
	const source = root && (await targetSource(root, url, 'Source to change'));
	if (!root || !source) {
		return;
	}
	const current = readSources(sourcesYaml(root));
	const priority = current.ok ? current.value.find((s) => s.url === source)?.priority : undefined;
	const next = await vscode.window.showInputBox({
		prompt: `Priority of ${source} (integer; lower is preferred)`,
		value: priority === undefined ? '' : String(priority),
		validateInput: (value) => (PRIORITY_PATTERN.test(value.trim()) ? undefined : 'Priority must be an integer'),
	});
	if (next === undefined || Number(next.trim()) === priority) {
		return;
	}
	await applySourceEdit(root, source, { kind: 'priority', priority: Number(next.trim()) }, refresh);
}

export async function deleteSource(refresh: Refresh, url?: string): Promise<void> {
	const root = requireBsp();
	const source = root && (await targetSource(root, url, 'Source to delete'));
	if (!root || !source) {
		return;
	}
	const confirmed = await vscode.window.showWarningMessage(`Remove ${source} from Modules/sources.yaml?`, { modal: true }, 'Remove');
	if (confirmed !== 'Remove') {
		return;
	}
	await applySourceEdit(root, source, { kind: 'remove' }, refresh);
}

// ---------------------------------------------------------------------------------------
// Module skeleton

export async function createModuleWizard(): Promise<void> {
	const root = getWorkspaceRoot();
	if (!root) {
		return;
	}
	const name = await vscode.window.showInputBox({
		prompt: 'Module class name',
		placeHolder: 'MyModule',
		validateInput: (value) => (isIdentifier(value.trim()) ? undefined : 'Module name must be a C++ identifier'),
	});
	if (!name) {
		return;
	}
	const description = await vscode.window.showInputBox({ prompt: 'Description (optional)' });
	if (description === undefined) {
		return;
	}
	const constructorText = await vscode.window.showInputBox({
		prompt: 'Constructor parameter declarations (C++, separated by ";", optional)',
		placeHolder: 'LibXR::GPIO& led; uint32_t blink_cycle = 250',
	});
	if (constructorText === undefined) {
		return;
	}
	const templateText = await vscode.window.showInputBox({
		prompt: 'Template parameter declarations (C++, separated by ";", optional)',
		placeHolder: 'typename ChassisType',
	});
	if (templateText === undefined) {
		return;
	}
	// The Module CI compiles one constructor call, so a template parameter without a
	// default needs a value there.
	const templateArgumentText = templateText.trim()
		? await vscode.window.showInputBox({
				prompt: 'Template arguments the Module CI compiles with (C++, separated by ";"; parameters with defaults may be left out)',
				placeHolder: 'Mecanum',
			})
		: '';
	if (templateArgumentText === undefined) {
		return;
	}
	const dependsText = await vscode.window.showInputBox({
		prompt: 'Module dependencies (owner/Repo[@ref], space-separated, optional)',
		validateInput: (value) =>
			value.trim() && !value.trim().split(/\s+/).every((d) => REQUEST_PATTERN.test(d)) ? 'Expected owner/Repo[@ref] entries' : undefined,
	});
	if (dependsText === undefined) {
		return;
	}
	const folder = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		defaultUri: vscode.Uri.file(root),
		openLabel: `Create ${name.trim()} here`,
	});
	if (!folder || folder.length === 0) {
		return;
	}
	const split = (text: string): string[] =>
		text
			.split(';')
			.map((item) => item.trim())
			.filter(Boolean);
	const outDir = folder[0].fsPath;
	const moduleName = name.trim();
	const outcome = await runLogged(
		'xrobot',
		xrobotArgs.newModule({
			name: moduleName,
			description: description.trim(),
			constructorParameters: split(constructorText),
			templateParameters: split(templateText),
			templateArguments: split(templateArgumentText),
			depends: dependsText.trim() ? dependsText.trim().split(/\s+/) : [],
			outDir,
		}),
		root,
		{ reveal: true },
	);
	if (!reportOutcome('xrobot new-module', outcome)) {
		return;
	}
	const moduleDir = path.join(outDir, moduleName);
	const header = path.join(moduleDir, `${moduleName}.hpp`);
	try {
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(header), { preview: false });
	} catch {
		// The CLI reported success; the output channel shows where it wrote.
	}
	// A BSP reads only the Modules in xrobot.lock, so the new folder does not appear in the
	// XRobot view until it is published and requested; the generated README says how.
	void vscode.window.showInformationMessage(
		`Created ${moduleDir}. The XRobot view lists only Modules from xrobot.lock; ${moduleName}/README.md describes how a BSP uses the Module.`,
	);
}

// ---------------------------------------------------------------------------------------
// Startup check (XRobot BSPs only, asynchronous).

async function pythonHasModule(python: string, module: string, cwd: string): Promise<boolean> {
	const result = await runProcess(
		python,
		['-c', 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(sys.argv[1]) else 1)', module],
		{ cwd, env: cliEnv() },
	).done;
	return result.code === 0;
}

export async function checkDependencies(extensionDir: string): Promise<void> {
	const root = getWorkspaceRoot();
	if (!root || !isXrobotBsp(root)) {
		return;
	}
	const env = cliEnv();
	const problems: string[] = [];
	const notes: string[] = [];
	if (!findExecutable('git', env)) {
		problems.push('git was not found on PATH (xrobot setup needs it)');
	}
	const version = await startQuiet('xrobot', xrobotArgs.version(), root).done;
	if (version.ok) {
		const invocation = invocationFor('xrobot', root, env);
		notes.push(`${version.stdout.trim()} (${invocation?.display ?? 'xrobot'})`);
	} else {
		problems.push(`xrobot CLI unavailable: ${version.message ?? 'unknown error'} (pip install xrobot)`);
	}
	if (detectIocFiles(root).length > 0) {
		const libxr = invocationFor('libxr', root, env);
		const available = libxr && (libxr.prefix.length === 0 || (await pythonHasModule(libxr.command, 'libxr', extensionDir)));
		if (!available) {
			notes.push('libxr CLI not found; the LibXR view actions need `pip install -U libxr` (6.0.0 or later)');
		}
	}
	for (const note of notes) {
		outputChannel.appendLine(`[check] ${note}`);
	}
	if (problems.length === 0) {
		return;
	}
	for (const problem of problems) {
		outputChannel.appendLine(`[check] ERROR ${problem}`);
	}
	void vscode.window.showWarningMessage(`XRobot: ${problems[0]}`, 'Show Output').then((choice) => {
		if (choice) {
			outputChannel.show(true);
		}
	});
}
