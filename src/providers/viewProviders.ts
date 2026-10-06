import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCollection, parseDocument } from 'yaml';
import { asRecord, parseYamlSafe } from '../yaml/yamlStore';
import { discoverUserLibxrConfigs } from './workspaceConfigDiscovery';
import {
	argName,
	constructorSignature,
	describeSummary,
	diagnosticsFor,
	errorCount,
	findMatchingConstructor,
	isRecord,
	previewTree,
	shortCommit,
	type DescribeInstance,
	type DescribeModule,
	type DescribeParameter,
	type DescribeResult,
	type ValueTree,
} from './describeModel';
import { readModuleRequests, readSources } from './workspaceFiles';
import { flashMapSize, formatAddress, formatBytes, formatRun, readFlashMap, type FlashMap } from './flashMap';
import { canSwitchConstructor, type InstanceEditTarget } from './instanceEditor';
import { libxrArgs, xrobotArgs, type PathSegment } from '../cli/xrobotCli';
import { describeService, getWorkspaceRoot, isXrobotBsp, reportOutcome, runLogged, type DescribeOutcome } from '../cliHost';
import { REMOTE_VERSION_DEFAULT_LABEL } from '../uiText';
import { detectPinsProject } from '../pins/project';
import { pinsService, type PinsState } from '../pinsService';
import { categoryOf, type Category } from '../pins/model';
import { usedPeripherals, type UsedPeripheral } from '../pins/view';

export type CliRunRequest = {
	label: string;
	// Console script name (`xrobot` or `libxr`); subcommands go into args.
	tool: string;
	args?: string[];
	promptInput?: boolean;
	inputPrompt?: string;
	defaultInput?: string;
};

export type OpenFileTarget = {
	absolutePath: string;
	displayPath: string;
	exists: boolean;
};

export type TreeNode = GroupNode | FileNode | YamlValueNode | ActionNode | UrlNode | MessageNode | OpNode | PeripheralNode;

type GroupNode = {
	type: 'group';
	// Keeps the item (and whether it is open) across refreshes.
	id?: string;
	label: string;
	children: TreeNode[];
	expanded?: boolean;
	description?: string;
	iconId?: string;
	tooltip?: string;
	// A theme colour id for the icon.
	color?: string;
};

type FileNode = {
	type: 'file';
	label: string;
	absolutePath: string;
	displayPath: string;
	exists: boolean;
	yamlExpandable: boolean;
	description?: string;
	contextValue?: string;
};

type YamlValueNode = {
	type: 'yamlValue';
	label: string;
	value: unknown;
	depth: number;
	filePath?: string;
	keyPath?: Array<string | number>;
	editable?: boolean;
};

type ActionNode = {
	type: 'action';
	label: string;
	runRequest: CliRunRequest;
};

type UrlNode = {
	type: 'url';
	label: string;
	url: string;
	description?: string;
};

type MessageNode = {
	type: 'message';
	label: string;
	description?: string;
	iconId?: string;
	tooltip?: string;
};

type OpNode = {
	type: 'op';
	label: string;
	description?: string;
	command: string;
	args?: unknown[];
	iconId?: string;
};

// A peripheral the project selected: its pins and settings below it; clicking it opens the pin
// layout with the peripheral selected.
type PeripheralNode = {
	type: 'peripheral';
	label: string;
	description: string;
	// Markdown: the pins and where the settings are.
	tooltip: string;
	category: Category;
	peripheral: string;
	children: TreeNode[];
};

type WorkspaceContext = {
	root: string;
	iocFiles: string[];
	selectedIoc?: string;
	platform: 'stm32' | 'mspm0' | 'hpm' | 'unknown';
	// The .ioc, .hpmpc or .syscfg the platform was recognized from.
	pinsSource?: string;
	libxrConfigRel: string;
	libxrConfigAbs: string;
	appMainRel: string;
	appMainAbs: string;
	libxrConfigCandidates: string[];
	hasLibxrConfig: boolean;
	xrobotBsp: boolean;
};

// Provider: LibXR view tree
export class LibxrTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
	public readonly onDidChangeTreeData = this.onDidChangeEmitter.event;
	// The parents of the nodes of the last build and the peripheral items, so one can be revealed.
	private readonly parents = new Map<TreeNode, TreeNode>();
	private readonly peripheralItems = new Map<string, PeripheralNode>();

	getParent(element: TreeNode): TreeNode | undefined {
		return this.parents.get(element);
	}

	// Selects the item of a peripheral in the tree (the panel selected it); the item's click
	// command is not run. Nothing happens while the view is hidden.
	revealPeripheral(view: vscode.TreeView<TreeNode>, name: string | null): void {
		const node = name ? this.peripheralItems.get(name) : undefined;
		if (!node || !view.visible) {
			return;
		}
		void Promise.resolve(view.reveal(node, { select: true, focus: false, expand: false })).then(undefined, () => undefined);
	}

	private indexTree(nodes: TreeNode[], parent?: TreeNode): void {
		for (const node of nodes) {
			if (parent) {
				this.parents.set(node, parent);
			}
			if (node.type === 'peripheral') {
				this.peripheralItems.set(node.peripheral, node);
			}
			if (node.type === 'group' || node.type === 'peripheral') {
				this.indexTree(node.children, node);
			}
		}
	}

	refresh(): void {
		this.onDidChangeEmitter.fire(undefined);
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return createTreeItem(element);
	}

	getChildren(element?: TreeNode): TreeNode[] {
		const ctx = getWorkspaceContext();
		if (!ctx) {
			return [messageNode('Open a workspace folder to use XRobot extension.')];
		}

		if (!element) {
			const root = this.buildRoot(ctx);
			this.parents.clear();
			this.peripheralItems.clear();
			this.indexTree(root);
			return root;
		}

		if (element.type === 'group' || element.type === 'peripheral') {
			return element.children;
		}

		if (element.type === 'file') {
			return yamlChildrenForFile(element);
		}

		if (element.type === 'yamlValue') {
			return yamlChildrenForValue(element);
		}

		return [];
	}

	// The LibXR view, top to bottom: the chip (its pin layout, source file and system), what the
	// project uses (the peripherals, with their settings), then the Flash layout, the files and the
	// actions. The chip and the peripherals come from the shared `libxr pins` result.
	private buildRoot(ctx: WorkspaceContext): TreeNode[] {
		if (ctx.platform === 'unknown') {
			return [
				messageNode(
					'No platform recognized: the workspace root needs an STM32CubeMX .ioc, or a SysConfig ti_msp_dl_config.h for an MSPM0.',
				),
			];
		}
		const state = pinsService.state;
		// The settings of a peripheral are edited in libxr_config.yaml (an STM32 only).
		const settingsFile = ctx.platform === 'stm32' && ctx.hasLibxrConfig ? ctx.libxrConfigAbs : undefined;

		if (ctx.platform === 'mspm0') {
			// The pin layout works for an MSPM0; LibXR code generation is STM32 only.
			return [
				chipNode(ctx, state),
				...peripheralsNodes(state, settingsFile, ctx.root),
				messageNode('Code generation: STM32 only'),
			];
		}

		if (!ctx.hasLibxrConfig) {
			return [
				chipNode(ctx, state),
				...peripheralsNodes(state, settingsFile),
				groupNode(
					'Actions',
					[
						actionNode('Configure CubeMX (libxr stm32 setup)', {
							label: 'libxr stm32 setup',
							tool: 'libxr',
							args: ['stm32', 'setup', '-d', '.'],
						}),
					],
					false,
				),
			];
		}

		const configItem = fileNode('Config File', ctx.libxrConfigAbs, ctx.libxrConfigRel, 'force', {
			description: ctx.libxrConfigRel,
			contextValue: 'xrobot.libxr.configPath',
		});
		const appMainItem = fileNode('App Main', ctx.appMainAbs, ctx.appMainRel, 'none', {
			description: ctx.appMainRel,
			contextValue: 'xrobot.libxr.appMainPath',
		});

		const flashLayoutNodes = this.buildFlashLayoutNodes(ctx);
		const flashSummary = this.buildFlashLayoutSummary(ctx);
		const flashLabel = flashSummary ? `Flash Layout: ${flashSummary}` : 'Flash Layout';

		return [
			chipNode(ctx, state, this.buildSystemItem(ctx)),
			...peripheralsNodes(state, settingsFile),
			groupNode(flashLabel, flashLayoutNodes, false),
			configItem,
			groupNode('Actions', this.buildActions(ctx), false),
			appMainItem,
		];
	}

	private buildSystemItem(ctx: WorkspaceContext): TreeNode {
		const rootObj = this.readLibxrConfigRoot(ctx);
		if (!rootObj) {
			return messageNode('System: unknown');
		}
		const system = rootObj.SYSTEM;
		if (system === undefined) {
			return messageNode('System: (missing)');
		}
		return messageNode(`System: ${String(system)}`);
	}

	// `libxr gen` writes the internal Flash layout to flash_map.hpp next to app_main.cpp.
	private flashMapPath(ctx: WorkspaceContext): { abs: string; rel: string } {
		const abs = path.join(path.dirname(ctx.appMainAbs), 'flash_map.hpp');
		return { abs, rel: path.relative(ctx.root, abs).replace(/\\/g, '/') };
	}

	private readFlashMap(ctx: WorkspaceContext): FlashMap | undefined {
		return readFlashMap(this.flashMapPath(ctx).abs);
	}

	private buildFlashLayoutSummary(ctx: WorkspaceContext): string | undefined {
		const map = this.readFlashMap(ctx);
		if (!map || map.runs.length === 0) {
			return undefined;
		}
		const size = formatBytes(flashMapSize(map));
		return map.mcu ? `${map.mcu} ${size}` : size;
	}

	private buildFlashLayoutNodes(ctx: WorkspaceContext): TreeNode[] {
		const file = this.flashMapPath(ctx);
		const map = this.readFlashMap(ctx);
		if (!map) {
			return [messageNode(`${file.rel} (missing or invalid; run libxr gen)`)];
		}
		if (map.runs.length === 0) {
			return [messageNode(`${file.rel} (no Flash regions)`)];
		}
		return [
			messageNode(`Model: ${map.mcu ?? 'unknown'}`),
			messageNode(`Base: ${formatAddress(map.runs[0].address)}`),
			messageNode(`Size: ${formatBytes(flashMapSize(map))}`),
			groupNode('Sectors', map.runs.map((run) => messageNode(formatRun(run))), false),
			fileNode('Flash Map', file.abs, file.rel, 'none', { description: file.rel }),
		];
	}

	private readLibxrConfigRoot(ctx: WorkspaceContext): Record<string, unknown> | undefined {
		const parsed = parseYamlSafe(ctx.libxrConfigAbs);
		if (!parsed.ok) {
			return undefined;
		}
		return asRecord(parsed.value);
	}

	private buildActions(ctx: WorkspaceContext): TreeNode[] {
		const appMainArg = `./${ctx.appMainRel.replace(/\\/g, '/').replace(/^\.?\//, '')}`;
		const iocDir = ctx.selectedIoc ? path.dirname(ctx.selectedIoc).replace(/\\/g, '/') : '.';
		const parseIocOut = stm32ParsedConfigArg();
		const libxrConfigArg = `./${ctx.libxrConfigRel.replace(/\\/g, '/').replace(/^\.?\//, '')}`;
		const flashModel = this.readFlashModel(ctx) ?? 'STM32F103C8';
		const nodes: TreeNode[] = [];
		const withXrobot = ctx.xrobotBsp;
		const xrobotFlag = withXrobot ? ' --xrobot' : '';
		const projectDir = iocDir === '' ? '.' : iocDir;

		if (ctx.platform === 'stm32') {
			nodes.push(
				actionNode('Configure CubeMX (libxr stm32 setup)', {
					label: 'libxr stm32 setup',
					tool: 'libxr',
					args: withXrobot ? ['stm32', 'setup', '-d', '.', '--xrobot'] : ['stm32', 'setup', '-d', '.'],
				}),
			);
			nodes.push(
				actionNode('Parse IOC (libxr parse)', {
					label: 'libxr parse',
					tool: 'libxr',
					args: ['parse'],
					promptInput: true,
					defaultInput: `-d ${iocDir === '' ? '.' : iocDir} -o ${parseIocOut} --verbose`,
					inputPrompt: `Example: -d <CubeMXDir> -o ${parseIocOut} --verbose`,
				}),
				actionNode('Generate STM32 Code (libxr gen)', {
					label: 'libxr gen',
					tool: 'libxr',
					args: ['gen'],
					promptInput: true,
					defaultInput: `-i ${parseIocOut} -d ${projectDir} -o ${appMainArg}${xrobotFlag} --libxr-config ${libxrConfigArg}`,
					inputPrompt: `Example: -i ${parseIocOut} -d ${projectDir} -o ${appMainArg}${xrobotFlag} --libxr-config ${libxrConfigArg}`,
				}),
				actionNode('Show STM32 Flash Info (libxr stm32 flash-info)', {
					label: 'libxr stm32 flash-info',
					tool: 'libxr',
					args: ['stm32', 'flash-info'],
					promptInput: true,
					defaultInput: flashModel,
					inputPrompt: 'Example: STM32F103C8',
				}),
			);
		}
		if (nodes.length === 0) {
			nodes.push(messageNode('No platform-specific actions (need *.ioc in workspace root)'));
		}

		return nodes;
	}

	private readFlashModel(ctx: WorkspaceContext): string | undefined {
		return this.readFlashMap(ctx)?.mcu;
	}
}

// Provider: XRobot view tree. Everything about the application (product, header, lock,
// Module interfaces, instances, diagnostics) comes from `xrobot describe`; Module
// requests and sources are listed from Modules/modules.yaml and Modules/sources.yaml.
export class XrobotTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
	public readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

	refresh(): void {
		describeService.invalidate();
		this.onDidChangeEmitter.fire(undefined);
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return createTreeItem(element);
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		const root = getWorkspaceRoot();
		if (!root) {
			return [messageNode('Open a workspace folder to use XRobot extension.')];
		}
		if (!element) {
			return this.buildRoot(root);
		}
		if (element.type === 'group') {
			return element.children;
		}
		return [];
	}

	private async buildRoot(root: string): Promise<TreeNode[]> {
		if (!isXrobotBsp(root)) {
			return [
				messageNode('Not an XRobot BSP (no Modules/modules.yaml)', undefined, { iconId: 'info' }),
				groupNode(
					'Actions',
					[actionNode('Initialize XRobot here (xrobot init)', { label: 'xrobot init', tool: 'xrobot', args: xrobotArgs.init(root) })],
					true,
				),
			];
		}
		const outcome: DescribeOutcome = await describeService.current(root);
		const nodes: TreeNode[] = [];
		const describe = outcome.ok ? outcome.value : undefined;
		if (!outcome.ok) {
			nodes.push(messageNode(`xrobot describe failed: ${outcome.error}`, undefined, { iconId: 'error', tooltip: outcome.error }));
		} else {
			const value = outcome.value;
			nodes.push(
				groupNode('Status', this.buildStatus(root, value), errorCount(value) > 0, describeSummary(value)),
				groupNode('Products', this.buildProducts(root, value), false, value.selected, { iconId: 'files' }),
				groupNode('Instances', this.buildInstances(root, value), true, value.config, { iconId: 'symbol-class' }),
			);
		}
		nodes.push(
			groupNode('Modules', this.buildModules(root, describe), false),
			groupNode('Sources', this.buildSources(root), false),
			groupNode('Actions', this.buildActions(root), false),
		);
		return nodes;
	}

	private buildStatus(root: string, describe: DescribeResult): TreeNode[] {
		const nodes: TreeNode[] = [];
		const header = describe.header;
		const headerChildren: TreeNode[] = header.missing.map((p) =>
			messageNode(`missing: ${p}`, undefined, { iconId: 'error' }),
		);
		const headerLabel = `Header: ${header.status}`;
		const headerDescription = header.config ? `${header.path} for ${header.config}` : header.path;
		nodes.push(
			headerChildren.length > 0
				? groupNode(headerLabel, headerChildren, false, headerDescription, { iconId: statusIconId(header.status) })
				: messageNode(headerLabel, headerDescription, { iconId: statusIconId(header.status) }),
		);

		const tool = describe.tools.xrobot;
		nodes.push(
			messageNode(`xrobot ${tool.installed}`, tool.pin ? `pinned ${tool.pin}` : 'not pinned', {
				iconId: tool.pin === tool.installed ? 'pass' : 'warning',
			}),
		);

		const lock = describe.lock;
		const lockChildren: TreeNode[] = lock.modules.map((mod) => {
			const head = mod.head && mod.head !== mod.commit ? `, head ${shortCommit(mod.head)}` : '';
			return messageNode(mod.id, `${shortCommit(mod.commit)} ${mod.status}${head}`, {
				iconId: statusIconId(mod.status),
				tooltip: `${mod.id}\nlocked: ${mod.commit ?? '-'}\nhead: ${mod.head ?? '(not checked out)'}`,
			});
		});
		if (lockChildren.length === 0) {
			lockChildren.push(messageNode(lock.present ? '(no Modules locked)' : `${lock.path} does not exist`));
		}
		nodes.push(groupNode(`Lock: ${lock.status}`, lockChildren, false, lock.path, { iconId: statusIconId(lock.status) }));

		if (describe.entry) {
			const registrations = describe.registrations.map((r) => messageNode(r.name, r.type, { iconId: 'symbol-variable' }));
			nodes.push(
				fileNode('Entry', path.join(root, describe.entry), describe.entry, 'none', { description: describe.entry }),
				groupNode(
					'Registrations',
					registrations.length > 0 ? registrations : [messageNode('(no XR_REGISTER)')],
					false,
					`${registrations.length}`,
					{ iconId: 'symbol-variable' },
				),
			);
		}

		const errors = errorCount(describe);
		const diagnosticNodes = describe.diagnostics.map((d) =>
			messageNode(`${d.scope}: ${d.message}`, d.severity, {
				iconId: d.severity === 'error' ? 'error' : 'warning',
				tooltip: `[${d.severity}] ${d.scope}\n${d.message}`,
			}),
		);
		nodes.push(
			groupNode(
				'Diagnostics',
				diagnosticNodes.length > 0 ? diagnosticNodes : [messageNode('no diagnostics', undefined, { iconId: 'pass' })],
				errors > 0,
				`${errors} errors, ${describe.diagnostics.length - errors} warnings`,
				{ iconId: errors > 0 ? 'error' : describe.diagnostics.length > 0 ? 'warning' : 'pass' },
			),
		);
		return nodes;
	}

	private buildProducts(root: string, describe: DescribeResult): TreeNode[] {
		if (describe.configs.length === 0) {
			return [messageNode('(no application configs under User/)')];
		}
		return describe.configs.map((config) => {
			const selected = config === describe.selected;
			const children: TreeNode[] = [fileNode('open', path.join(root, config), config, 'none')];
			if (!selected) {
				children.push(opNode('select this product (xrobot gen -c)', 'xrobot.selectProduct', [config], undefined, 'target'));
			}
			return groupNode(config, children, false, selected ? 'selected' : undefined, {
				iconId: selected ? 'pass-filled' : 'file',
				tooltip: selected ? `${describe.header.path} is generated for ${config}` : config,
			});
		});
	}

	private buildInstances(root: string, describe: DescribeResult): TreeNode[] {
		const nodes: TreeNode[] = [fileNode('open config', path.join(root, describe.config), describe.config, 'none')];
		// A config that fails to load is reported here, never replaced by another config.
		for (const d of diagnosticsFor(describe, describe.config)) {
			nodes.push(messageNode(d.message, d.severity, { iconId: d.severity === 'error' ? 'error' : 'warning', tooltip: d.message }));
		}
		nodes.push(opNode('add instance (xrobot instance add)', 'xrobot.addModuleInstance', [], undefined, 'add'));
		for (const instance of describe.instances) {
			nodes.push(this.buildInstance(root, describe, instance));
		}
		return nodes;
	}

	private buildInstance(root: string, describe: DescribeResult, instance: DescribeInstance): TreeNode {
		const module = describe.modules[instance.module];
		const children: TreeNode[] = [];
		if (module?.header) {
			children.push(fileNode(`module: ${instance.module}`, path.join(root, module.header), module.header, 'none', { description: module.class }));
		} else {
			children.push(messageNode(`module: ${instance.module}`, 'not in the locked sources', { iconId: 'warning' }));
		}
		children.push(opNode(`id: ${instance.id}`, 'xrobot.editModuleInstance', [instance.id, { kind: 'id' }], 'rename', 'edit'));

		const templateParams = module?.template_parameters ?? [];
		const templateCount = Math.max(templateParams.length, instance.template_args.length);
		if (templateCount > 0) {
			const templateNodes: TreeNode[] = [];
			for (let i = 0; i < templateCount; i += 1) {
				const target: InstanceEditTarget = { kind: 'template', index: i };
				templateNodes.push(
					opNode(
						`${templateParams[i]?.name ?? `#${i}`}: ${previewTree(instance.template_args[i])}`,
						'xrobot.editModuleInstance',
						[instance.id, target],
						templateParams[i]?.type,
						instance.template_args[i] === null ? 'warning' : 'symbol-type-parameter',
					),
				);
			}
			children.push(groupNode('template_args', templateNodes, false));
		}

		children.push(groupNode('args', this.buildArgs(instance, module), false));
		children.push(opNode('delete instance', 'xrobot.deleteModuleInstance', [instance.id], undefined, 'trash'));
		const unfilled =
			instance.template_args.some((v) => v === null) ||
			instance.args.some((arg) => {
				const name = argName(arg);
				return name !== undefined && arg[name] === null;
			});
		return groupNode(instance.id, children, false, module?.class ?? instance.module, {
			iconId: unfilled ? 'warning' : 'symbol-class',
			tooltip: unfilled ? `${instance.id} has values that are not filled in (null)` : undefined,
		});
	}

	private buildArgs(instance: DescribeInstance, module: DescribeModule | undefined): TreeNode[] {
		const ctorIndex = findMatchingConstructor(module, instance.args);
		const ctor = ctorIndex >= 0 ? module?.constructors?.[ctorIndex] : undefined;
		const nodes: TreeNode[] = [];
		if (module?.constructors && module.constructors.length > 0 && !ctor) {
			nodes.push(
				messageNode(`args match no constructor of ${module.class}`, undefined, {
					iconId: 'error',
					tooltip: module.constructors.map(constructorSignature).join('\n'),
				}),
			);
		}
		if (canSwitchConstructor(module, instance)) {
			const target: InstanceEditTarget = { kind: 'constructor' };
			nodes.push(opNode('switch constructor…', 'xrobot.editModuleInstance', [instance.id, target], 'keeps same-named values', 'list-ordered'));
		}
		for (const arg of instance.args) {
			const name = argName(arg);
			if (!name) {
				continue;
			}
			nodes.push(this.buildValue(instance.id, name, [], arg[name], ctor?.parameters.find((p) => p.name === name)));
		}
		return nodes.length > 0 ? nodes : [messageNode('(no args)')];
	}

	private buildValue(id: string, name: string, segments: PathSegment[], value: ValueTree, param: DescribeParameter | undefined): TreeNode {
		const last = segments[segments.length - 1];
		const label = last === undefined ? name : typeof last === 'number' ? `[${last}]` : last;
		const target: InstanceEditTarget = { kind: 'arg', name, path: segments };
		const type = segments.length === 0 ? param?.type : undefined;
		if (Array.isArray(value) || isRecord(value)) {
			const entries: Array<[PathSegment, ValueTree]> = Array.isArray(value)
				? value.map((v, i) => [i, v])
				: Object.entries(value as Record<string, ValueTree>);
			return groupNode(
				label,
				[
					opNode(`edit ${label}`, 'xrobot.editModuleInstance', [id, target], type, 'edit'),
					...entries.map(([key, child]) => this.buildValue(id, name, [...segments, key], child, param)),
				],
				false,
				previewTree(value),
				{ iconId: 'symbol-structure', tooltip: previewTree(value, 2000) },
			);
		}
		const unfilled = value === null;
		const description = unfilled ? (param?.dependency ? `${param.type}: dependency, not filled in` : 'not filled in') : type;
		return opNode(`${label}: ${previewTree(value)}`, 'xrobot.editModuleInstance', [id, target], description, unfilled ? 'warning' : 'symbol-field');
	}

	private buildModules(root: string, describe: DescribeResult | undefined): TreeNode[] {
		const nodes: TreeNode[] = [opNode('add module (xrobot module add)', 'xrobot.addRepo', [], undefined, 'add')];
		const requests = readModuleRequests(path.join(root, 'Modules', 'modules.yaml'));
		if (!requests.ok) {
			nodes.push(messageNode(`Modules/modules.yaml: ${requests.error}`, undefined, { iconId: 'error', tooltip: requests.error }));
			return nodes;
		}
		for (const request of requests.value) {
			const key = request.id.toLowerCase();
			const children: TreeNode[] = [
				opNode(`version: ${request.ref ?? REMOTE_VERSION_DEFAULT_LABEL}`, 'xrobot.editRepoVersion', [request.id], undefined, 'versions'),
			];
			const locked = describe?.lock.modules.find((m) => m.id.toLowerCase() === key);
			if (locked) {
				children.push(messageNode(`locked: ${shortCommit(locked.commit)}`, locked.status, { iconId: statusIconId(locked.status) }));
			} else if (describe) {
				children.push(messageNode('not in xrobot.lock', undefined, { iconId: 'warning' }));
			}
			const described = describe ? Object.values(describe.modules).find((m) => m.id.toLowerCase() === key) : undefined;
			if (described?.header) {
				children.push(fileNode('module header', path.join(root, described.header), described.header, 'none'));
			}
			if (described?.error) {
				children.push(messageNode(`interface error: ${described.error}`, undefined, { iconId: 'error', tooltip: described.error }));
			}
			children.push(opNode('remove (xrobot module remove)', 'xrobot.deleteRepo', [request.id], undefined, 'trash'));
			nodes.push(groupNode(request.id, children, false, request.ref ?? REMOTE_VERSION_DEFAULT_LABEL, { iconId: 'package' }));
		}
		if (requests.value.length === 0) {
			nodes.push(messageNode('(no Module requests)'));
		}
		return nodes;
	}

	private buildSources(root: string): TreeNode[] {
		const nodes: TreeNode[] = [opNode('add source (xrobot source add-source)', 'xrobot.addSource', [], undefined, 'add')];
		const sourcesPath = path.join(root, 'Modules', 'sources.yaml');
		if (!fs.existsSync(sourcesPath)) {
			nodes.push(messageNode('Modules/sources.yaml (missing)'));
			return nodes;
		}
		const sources = readSources(sourcesPath);
		if (!sources.ok) {
			nodes.push(messageNode(`Modules/sources.yaml: ${sources.error}`, undefined, { iconId: 'error', tooltip: sources.error }));
			return nodes;
		}
		for (const source of sources.value) {
			const children: TreeNode[] = [];
			if (source.protected) {
				children.push(messageNode(`priority: ${source.priority}`), messageNode('official source (read-only)', undefined, { iconId: 'lock' }));
			} else {
				children.push(
					opNode(`priority: ${source.priority}`, 'xrobot.editSourcePriority', [source.url], undefined, 'edit'),
					opNode(`url: ${source.url}`, 'xrobot.editSourceUrl', [source.url], undefined, 'edit'),
				);
			}
			if (/^https?:\/\//i.test(source.url)) {
				children.push(urlNode('open url', source.url));
			} else {
				const abs = path.resolve(path.dirname(sourcesPath), source.url);
				children.push(fileNode('open file', abs, toWorkspacePath(root, abs), 'none'));
			}
			if (!source.protected) {
				children.push(opNode('delete source', 'xrobot.deleteSource', [source.url], undefined, 'trash'));
			}
			nodes.push(
				groupNode(sourceLabel(source.url), children, false, `priority ${source.priority}`, {
					iconId: source.protected ? 'lock' : 'repo',
					tooltip: source.url,
				}),
			);
		}
		if (sources.value.length === 0) {
			nodes.push(messageNode('(empty) sources'));
		}
		return nodes;
	}

	private buildActions(root: string): TreeNode[] {
		return [
			actionNode('Setup (xrobot setup)', { label: 'xrobot setup', tool: 'xrobot', args: xrobotArgs.setup(root) }),
			actionNode('Restore locked sources (xrobot setup --frozen)', {
				label: 'xrobot setup --frozen',
				tool: 'xrobot',
				args: xrobotArgs.setup(root, { kind: 'frozen' }),
			}),
			actionNode('Update all Modules (xrobot setup --update)', {
				label: 'xrobot setup --update',
				tool: 'xrobot',
				args: xrobotArgs.setup(root, { kind: 'update' }),
			}),
			actionNode('Regenerate header (xrobot gen)', { label: 'xrobot gen', tool: 'xrobot', args: xrobotArgs.gen(root) }),
			actionNode('Check config layout (xrobot format --check)', {
				label: 'xrobot format --check',
				tool: 'xrobot',
				args: xrobotArgs.format(root, true),
			}),
			actionNode('Format configs (xrobot format)', { label: 'xrobot format', tool: 'xrobot', args: xrobotArgs.format(root, false) }),
			opNode('Create Module (xrobot new-module)', 'xrobot.createModuleWizard', [], undefined, 'new-file'),
		];
	}
}

function sourceLabel(url: string): string {
	const parts = url.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
	const tail = parts.length <= 2 ? parts.join('/') : `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
	return tail.endsWith('/index.yaml') ? tail.slice(0, -'/index.yaml'.length) : tail;
}

function createTreeItem(node: TreeNode): vscode.TreeItem {
	if (node.type === 'peripheral') {
		const item = new vscode.TreeItem(
			node.label,
			node.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
		);
		item.id = `peripheral:${node.peripheral}`;
		item.description = node.description;
		item.tooltip = new vscode.MarkdownString(node.tooltip);
		item.iconPath = new vscode.ThemeIcon(CATEGORY_ICONS[node.category], CATEGORY_COLORS[node.category] ? new vscode.ThemeColor(CATEGORY_COLORS[node.category]!) : undefined);
		item.command = { command: 'xrobot.showPinLayout', title: 'Show Pin Layout', arguments: [{ peripheral: node.peripheral }] };
		return item;
	}

	if (node.type === 'group') {
		const item = new vscode.TreeItem(
			node.label,
			node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
		);
		if (node.id) {
			item.id = node.id;
		}
		item.description = node.description ?? `${node.children.length} items`;
		item.tooltip = node.tooltip;
		item.iconPath = new vscode.ThemeIcon(node.iconId ?? groupIconId(node.label), node.color ? new vscode.ThemeColor(node.color) : undefined);
		return item;
	}

	if (node.type === 'file') {
		const label = node.exists ? node.label : `${node.label} (missing)`;
		const collapsible =
			node.exists && node.yamlExpandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
		const item = new vscode.TreeItem(label, collapsible);
		item.tooltip = node.displayPath;
		item.description = node.description;
		item.contextValue = node.contextValue;
		item.iconPath = new vscode.ThemeIcon(fileIconId(node));
		item.command = {
			command: 'xrobot.openFile',
			title: 'Open File',
			arguments: [{ absolutePath: node.absolutePath, displayPath: node.displayPath, exists: node.exists } as OpenFileTarget],
		};
		return item;
	}

	if (node.type === 'yamlValue') {
		const expandable = canExpandYamlValue(node.value) && node.depth < 3;
		const item = new vscode.TreeItem(
			node.label,
			expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
		);
		item.description = previewValue(node.value);
		item.iconPath = new vscode.ThemeIcon(expandable ? 'symbol-object' : 'symbol-field');
		if (!expandable && node.editable && node.filePath && node.keyPath) {
			item.command = {
				command: 'xrobot.editYamlScalar',
				title: 'Edit Value',
				arguments: [node.filePath, node.keyPath],
			};
		}
		return item;
	}

	if (node.type === 'action') {
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon('terminal');
		item.command = { command: 'xrobot.runCli', title: 'Run CLI', arguments: [node.runRequest] };
		return item;
	}

	if (node.type === 'op') {
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.description = node.description;
		item.iconPath = new vscode.ThemeIcon(node.iconId ?? 'edit');
		item.command = { command: node.command, title: node.label, arguments: node.args ?? [] };
		return item;
	}

	if (node.type === 'url') {
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.description = node.description;
		item.tooltip = node.url;
		item.iconPath = new vscode.ThemeIcon('link-external');
		item.command = { command: 'xrobot.openUrl', title: 'Open URL', arguments: [node.url] };
		return item;
	}

	const msg = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
	msg.description = node.description;
	msg.tooltip = node.tooltip;
	msg.iconPath = new vscode.ThemeIcon(node.iconId ?? messageIconId(node.label));
	return msg;
}

function yamlChildrenForFile(node: FileNode): TreeNode[] {
	if (!node.exists || !node.yamlExpandable) {
		return [];
	}
	const parsed = parseYamlSafe(node.absolutePath);
	if (!parsed.ok) {
		return [messageNode(`Parse error: ${parsed.error}`)];
	}
	if (node.label === 'Config File') {
		const rootObj = asRecord(parsed.value);
		if (rootObj) {
			const shown = settingsShownInPeripherals(pinsService.state);
			const filtered: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(rootObj)) {
				if (k === 'SYSTEM' || k === 'FlashLayout') {
					continue;
				}
				// The settings of a peripheral are edited under Peripherals: not listed twice. What
				// the project does not use stays here, so nothing in the file is out of reach.
				const section = shown.get(k);
				const entries = asRecord(v);
				if (section && entries) {
					const rest = Object.fromEntries(Object.entries(entries).filter(([key]) => !section.has(key)));
					if (Object.keys(rest).length > 0) {
						filtered[k] = rest;
					}
					continue;
				}
				filtered[k] = v;
			}
			return toYamlValueNodes(filtered, 0, node.absolutePath, [], true);
		}
	}
	return toYamlValueNodes(parsed.value, 0, node.absolutePath, [], false);
}

// The sections and keys of libxr_config.yaml that the Peripherals group shows (peripherals the
// project uses that have settings in the file), so the Config File does not list them again. Empty
// while the shared `libxr pins` result is missing: the Config File then shows everything.
function settingsShownInPeripherals(state: PinsState): Map<string, Set<string>> {
	const result = state.status === 'ok' ? state.result : state.status === 'running' ? state.previous : undefined;
	const shown = new Map<string, Set<string>>();
	if (!result) {
		return shown;
	}
	for (const used of usedPeripherals(result)) {
		if (used.config?.present) {
			const keys = shown.get(used.config.section) ?? new Set<string>();
			keys.add(used.config.key);
			shown.set(used.config.section, keys);
		}
	}
	return shown;
}

function yamlChildrenForValue(node: YamlValueNode): TreeNode[] {
	if (!canExpandYamlValue(node.value) || node.depth >= 3) {
		return [];
	}
	return toYamlValueNodes(node.value, node.depth, node.filePath, node.keyPath ?? [], node.editable ?? false);
}

function toYamlValueNodes(
	value: unknown,
	depth: number,
	filePath?: string,
	basePath: Array<string | number> = [],
	editable = false,
): TreeNode[] {
	if (Array.isArray(value)) {
		return value.slice(0, 50).map((item, idx) => yamlNode(`[${idx}]`, item, depth + 1, filePath, [...basePath, idx], editable));
	}
	const obj = asRecord(value);
	if (obj) {
		return Object.entries(obj).map(([k, v]) => yamlNode(k, v, depth + 1, filePath, [...basePath, k], editable));
	}
	return [];
}

function yamlNode(
	label: string,
	value: unknown,
	depth: number,
	filePath?: string,
	keyPath?: Array<string | number>,
	editable = false,
): YamlValueNode {
	return { type: 'yamlValue', label, value, depth, filePath, keyPath, editable };
}

function canExpandYamlValue(value: unknown): boolean {
	return (Array.isArray(value) && value.length > 0) || (!!asRecord(value) && Object.keys(asRecord(value) ?? {}).length > 0);
}

function previewValue(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	if (typeof value === 'string') {
		return value.length > 60 ? `${value.slice(0, 57)}...` : value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (Array.isArray(value)) {
		return `Array(${value.length})`;
	}
	const obj = asRecord(value);
	if (obj) {
		const keys = Object.keys(obj);
		return keys.length > 0 ? `keys: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}` : 'Object(0)';
	}
	return String(value);
}

function groupNode(
	label: string,
	children: TreeNode[],
	expanded = false,
	description?: string,
	options?: { iconId?: string; tooltip?: string; id?: string; color?: string },
): GroupNode {
	return { type: 'group', id: options?.id, label, children, expanded, description, iconId: options?.iconId, tooltip: options?.tooltip, color: options?.color };
}

function fileNode(
	label: string,
	absolutePath: string,
	displayPath: string,
	yamlMode: boolean | 'auto' | 'force' | 'none' = 'auto',
	options?: { description?: string; contextValue?: string },
): FileNode {
	const exists = fs.existsSync(absolutePath);
	const normalizedMode = yamlMode === true ? 'force' : yamlMode === false ? 'auto' : yamlMode;
	const yamlExpandable =
		normalizedMode === 'force' ? true : normalizedMode === 'none' ? false : /\.(yaml|yml)$/i.test(displayPath);
	return {
		type: 'file',
		label,
		absolutePath,
		displayPath,
		exists,
		yamlExpandable,
		description: options?.description,
		contextValue: options?.contextValue,
	};
}

function actionNode(label: string, runRequest: CliRunRequest): ActionNode {
	return { type: 'action', label, runRequest };
}

// The pin layout panel (`libxr pins`) is a view of the chip, so it sits with the chip, not among
// the actions.
function pinLayoutNode(): OpNode {
	return opNode('Pin Layout', 'xrobot.showPinLayout', [], 'package drawing', 'circuit-board');
}

// The chip of the project: its part, package and pins, and below it the pin layout, the file the
// chip was read from and the system. While `libxr pins` runs the last result stays; when it fails the
// CLI's own message is shown here.
function chipNode(ctx: WorkspaceContext, state: PinsState, systemItem?: TreeNode): GroupNode {
	const result = state.status === 'ok' ? state.result : state.status === 'running' ? state.previous : undefined;
	let description: string | undefined;
	if (result) {
		description = `${result.package} · ${result.pin_count} pins`;
	} else if (state.status === 'running') {
		description = 'loading…';
	} else if (state.status === 'error') {
		description = 'unavailable';
	}
	const source = ctx.pinsSource ?? '';
	const children: TreeNode[] = [
		pinLayoutNode(),
		fileNode(path.basename(source), path.join(ctx.root, source), source, 'none', {
			description: ctx.platform === 'mspm0' ? 'SysConfig' : 'STM32CubeMX',
		}),
	];
	if (systemItem) {
		children.push(systemItem);
	}
	if (state.status === 'error') {
		children.push(messageNode(state.message, undefined, { iconId: 'error', tooltip: state.message }));
	}
	const platform = ctx.platform === 'mspm0' ? 'MSPM0' : 'STM32';
	return groupNode(result ? result.part : `${platform} project`, children, true, description, { iconId: 'chip', id: 'chip' });
}

const CATEGORY_ORDER: Category[] = ['comm', 'timer', 'analog', 'memory', 'other', 'gpio', 'system'];

const CATEGORY_TITLES: Record<Category, string> = {
	comm: 'Communication',
	timer: 'Timers',
	analog: 'Analog',
	gpio: 'GPIO',
	system: 'System',
	memory: 'Memory',
	other: 'Other',
};

const CATEGORY_ICONS: Record<Category, string> = {
	comm: 'plug',
	timer: 'watch',
	analog: 'pulse',
	gpio: 'circle-filled',
	system: 'gear',
	memory: 'database',
	other: 'circuit-board',
};

// XRobot Style: four data colours (the panel's channels), only for the four categories that have one;
// the others keep the default icon colour.
const CATEGORY_COLORS: Partial<Record<Category, string>> = {
	comm: 'charts.blue',
	timer: 'charts.yellow',
	analog: 'charts.green',
	gpio: 'charts.purple',
};

// What the pins of a peripheral say in one line: the first three, then how many more.
function pinsSummary(used: UsedPeripheral): string {
	const shown = used.pins.slice(0, 3).map((pin) => `${pin.function} ${pin.pin}`);
	const more = used.pins.length - shown.length;
	return more > 0 ? `${shown.join(' · ')} · +${more}` : shown.join(' · ');
}

// A value of a SysConfig setting in one line.
function settingText(value: unknown): string {
	return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

function peripheralTooltip(used: UsedPeripheral): string {
	const lines = [`**${used.name}** · ${used.kind}`, ''];
	for (const pin of used.pins) {
		lines.push(`- ${pin.function}: \`${pin.pin}\``);
	}
	if (used.sysconfig) {
		lines.push('', `SysConfig: \`${used.sysconfig.name ?? used.sysconfig.module}\``);
	}
	if (used.config) {
		lines.push('', used.config.present ? `Settings: \`${used.config.section}.${used.config.key}\`` : `Not in libxr_config.yaml (\`${used.config.section}.${used.config.key}\`)`);
	}
	return lines.join('\n');
}

// A peripheral the project selected. Its settings in libxr_config.yaml are its children and can be
// edited like the Config File (settingsFile), which regenerates the code.
function peripheralNode(used: UsedPeripheral, settingsFile?: string, sysconfigFile?: string): PeripheralNode {
	let children: TreeNode[] = [];
	if (used.sysconfig) {
		// An MSPM0: the settings are in the SysConfig project and are read-only here; SysConfig edits them.
		children = Object.entries(used.sysconfig.params).map(([name, value]) =>
			messageNode(`${name}: ${settingText(value)}`, undefined, { iconId: 'symbol-field' }),
		);
		if (sysconfigFile) {
			children.push(opNode('Open in SysConfig', 'vscode.open', [vscode.Uri.file(sysconfigFile)], path.basename(sysconfigFile), 'go-to-file'));
		}
	}
	if (used.config?.present && settingsFile) {
		children = toYamlValueNodes(used.config.params ?? {}, 0, settingsFile, [used.config.section, used.config.key], true);
	} else if (used.config && !used.config.present) {
		children = [messageNode(`Not in libxr_config.yaml yet (${used.config.section}.${used.config.key})`, undefined, { iconId: 'info' })];
	}
	const status = used.config && !used.config.present ? 'not configured' : '';
	return {
		type: 'peripheral',
		label: used.name,
		description: [pinsSummary(used), status].filter(Boolean).join(' · '),
		tooltip: peripheralTooltip(used),
		category: used.category,
		peripheral: used.name,
		children,
	};
}

// The peripherals the project selected, by category, from the shared `libxr pins` result. Nothing
// while there is no result (the chip says why).
function peripheralsNodes(state: PinsState, settingsFile?: string, root?: string): TreeNode[] {
	const result = state.status === 'ok' ? state.result : state.status === 'running' ? state.previous : undefined;
	if (!result) {
		return [];
	}
	const used = usedPeripherals(result);
	if (used.length === 0) {
		return [messageNode('Peripherals: the project selects none', undefined, { iconId: 'info' })];
	}
	const sysconfigFile = root && result.project?.sysconfig_file ? path.join(root, result.project.sysconfig_file) : undefined;
	const groups = CATEGORY_ORDER.map((category) => {
		const members = used.filter((peripheral) => peripheral.category === category);
		// GPIO and system pins are many and rarely what one looks for: they start closed.
		return members.length === 0
			? undefined
			: groupNode(
					CATEGORY_TITLES[category],
					members.map((peripheral) => peripheralNode(peripheral, settingsFile, sysconfigFile)),
					category !== 'gpio' && category !== 'system',
					String(members.length),
					{ iconId: CATEGORY_ICONS[category], id: `peripherals:${category}`, color: CATEGORY_COLORS[category] },
			  );
	}).filter((group): group is GroupNode => group !== undefined);
	return [groupNode('Peripherals', groups, true, `${used.length}`, { iconId: 'symbol-interface', id: 'peripherals' })];
}

function opNode(label: string, command: string, args: unknown[] = [], description?: string, iconId?: string): OpNode {
	return { type: 'op', label, command, args, description, iconId };
}

function urlNode(label: string, url: string, description?: string): UrlNode {
	return { type: 'url', label, url, description };
}

function messageNode(label: string, description?: string, options?: { iconId?: string; tooltip?: string }): MessageNode {
	return { type: 'message', label, description, iconId: options?.iconId, tooltip: options?.tooltip };
}

function statusIconId(status: string): string {
	switch (status) {
		case 'ok':
		case 'fresh':
			return 'pass';
		case 'stale':
		case 'mismatch':
		case 'unreadable':
		case 'absent':
			return 'warning';
		case 'missing':
		case 'broken':
			return 'error';
		default:
			return 'info';
	}
}

function groupIconId(label: string): string {
	switch (label) {
		case 'Modules':
			return 'package';
		case 'Sources':
			return 'repo';
		case 'Actions':
			return 'tools';
		case 'Status':
			return 'pulse';
		case 'args':
		case 'template_args':
			return 'symbol-parameter';
		default:
			return 'folder';
	}
}

function fileIconId(node: FileNode): string {
	if (!node.exists) {
		return 'warning';
	}
	if (node.label.startsWith('Platform: [STM32]')) {
		return 'chip';
	}
	if (node.label === 'Config File') {
		return 'json';
	}
	if (node.label === 'App Main' || node.label === 'Entry') {
		return 'file-code';
	}
	if (node.yamlExpandable) {
		return 'json';
	}
	return 'go-to-file';
}

function messageIconId(label: string): string {
	const lower = label.toLowerCase();
	if (lower.includes('parse error') || lower.includes('error')) {
		return 'error';
	}
	if (lower.includes('missing') || lower.includes('unknown')) {
		return 'warning';
	}
	return 'info';
}

function getWorkspaceContext(): WorkspaceContext | undefined {
	const root = getWorkspaceRoot();
	if (!root) {
		return undefined;
	}
	const iocFiles = detectIocFiles(root);
	const selectedIoc = resolveIocFile(root, iocFiles);
	const libxrConfig = resolveLibxrConfig(root);
	const pinsProject = detectPinsProject(root, selectedIoc ? [selectedIoc] : []);
	const appMainRel = getWorkspaceRelativeConfig('xrobot.libxr.appMainPath', 'User/app_main.cpp');
	return {
		root,
		iocFiles,
		selectedIoc,
		platform: pinsProject?.platform ?? 'unknown',
		pinsSource: pinsProject?.source,
		libxrConfigRel: libxrConfig.selectedRel,
		libxrConfigAbs: path.join(root, libxrConfig.selectedRel),
		libxrConfigCandidates: libxrConfig.candidates,
		hasLibxrConfig: fs.existsSync(path.join(root, libxrConfig.selectedRel)),
		appMainRel,
		appMainAbs: path.join(root, appMainRel),
		xrobotBsp: isXrobotBsp(root),
	};
}

export function detectIocFiles(root: string): string[] {
	try {
		return fs
			.readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.ioc'))
			.map((d) => d.name);
	} catch {
		return [];
	}
}

function resolveIocFile(root: string, iocFiles: string[]): string | undefined {
	const preferred = getWorkspaceRelativeConfig('xrobot.libxr.iocFile', '');
	if (preferred) {
		const abs = path.join(root, preferred);
		if (fs.existsSync(abs) && preferred.toLowerCase().endsWith('.ioc')) {
			return preferred;
		}
	}
	return iocFiles[0];
}

export function getWorkspaceRelativeConfig(key: string, fallback: string): string {
	const value = vscode.workspace.getConfiguration().get<string>(key, fallback).trim();
	return value ? value.replace(/\\/g, '/') : fallback;
}

function resolveLibxrConfig(root: string): { selectedRel: string; candidates: string[] } {
	const candidates = discoverUserLibxrConfigs(root);
	const configured = getWorkspaceRelativeConfig('xrobot.libxr.configPath', 'User/libxr_config.yaml');
	if (candidates.includes(configured)) {
		return { selectedRel: configured, candidates };
	}
	if (candidates.includes('User/libxr_config.yaml')) {
		return { selectedRel: 'User/libxr_config.yaml', candidates };
	}
	if (candidates.length > 0) {
		return { selectedRel: candidates[0], candidates };
	}
	return { selectedRel: configured, candidates: [] };
}

export function toWorkspacePath(root: string, abs: string): string {
	const rel = path.relative(root, abs).replace(/\\/g, '/');
	return rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel;
}

// LibXR config values (User/libxr_config.yaml): edited through the YAML document model so
// comments and layout of the rest survive, then LibXR code is regenerated.
export async function editYamlScalar(filePath?: string, keyPath?: Array<string | number>): Promise<void> {
	if (!filePath || !keyPath) {
		return;
	}
	let doc: ReturnType<typeof parseDocument>;
	try {
		doc = parseDocument(fs.readFileSync(filePath, 'utf8'));
	} catch (error) {
		void vscode.window.showErrorMessage(`Cannot load YAML: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (doc.errors.length > 0) {
		void vscode.window.showErrorMessage(`Cannot edit ${filePath}: ${doc.errors[0].message}`);
		return;
	}
	const current = doc.getIn(keyPath);
	if (isCollection(current)) {
		void vscode.window.showInformationMessage('Only scalar values are editable.');
		return;
	}
	const currentText = current === undefined || current === null ? '' : String(current);
	const input = await vscode.window.showInputBox({ prompt: `Edit ${keyPath.join('.')}`, value: currentText });
	if (input === undefined || input === currentText) {
		return;
	}
	doc.setIn(keyPath, parseScalarInput(input));
	try {
		fs.writeFileSync(filePath, doc.toString(), 'utf8');
	} catch (error) {
		void vscode.window.showErrorMessage(`Failed to write ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (normalizePath(filePath) === normalizePath(libxrConfigPath())) {
		await runLibxrGenerateCodeFromCurrent();
	}
}

export function parseScalarInput(input: string): unknown {
	const trimmed = input.trim();
	if (trimmed === 'null') {
		return null;
	}
	if (trimmed === 'true') {
		return true;
	}
	if (trimmed === 'false') {
		return false;
	}
	const num = Number(trimmed);
	if (trimmed !== '' && Number.isFinite(num)) {
		return num;
	}
	return input;
}

export function libxrConfigPath(): string {
	const root = getWorkspaceRoot() ?? '';
	const rel = getWorkspaceRelativeConfig('xrobot.libxr.configPath', 'User/libxr_config.yaml');
	return path.join(root, rel);
}

function stm32ParsedConfigArg(): string {
	return './.config.yaml';
}

function normalizePath(p: string): string {
	return path.resolve(p).toLowerCase();
}

// `libxr gen` reads the .config.yaml that `libxr parse` writes. That file is ignored by Git,
// so a fresh clone has none and parse runs first.
async function runLibxrGenerateCodeFromCurrent(): Promise<void> {
	const root = getWorkspaceRoot();
	if (!root) {
		return;
	}
	const ioc = resolveIocFile(root, detectIocFiles(root));
	const projectDir = ioc ? path.dirname(ioc).replace(/\\/g, '/') : '.';
	const appMainRel = getWorkspaceRelativeConfig('xrobot.libxr.appMainPath', 'User/app_main.cpp').replace(/\\/g, '/');
	const libxrConfigRel = getWorkspaceRelativeConfig('xrobot.libxr.configPath', 'User/libxr_config.yaml').replace(/\\/g, '/');
	const appMainArg = `./${appMainRel.replace(/^\.?\//, '')}`;
	const libxrConfigArg = `./${libxrConfigRel.replace(/^\.?\//, '')}`;
	const parsed = await runCli({
		label: 'libxr parse',
		tool: 'libxr',
		args: libxrArgs.parse(projectDir, stm32ParsedConfigArg()),
	});
	if (!parsed) {
		return;
	}
	await runCli({
		label: 'libxr gen',
		tool: 'libxr',
		args: libxrArgs.gen(stm32ParsedConfigArg(), appMainArg, libxrConfigArg, isXrobotBsp(root)),
	});
}

// Runs a tree action with the output channel revealed; a failure is reported with the
// CLI's own message. Resolves with whether the command succeeded.
export async function runCli(request?: CliRunRequest): Promise<boolean> {
	const root = getWorkspaceRoot();
	if (!root || !request) {
		return false;
	}
	const args = [...(request.args ?? [])];
	if (request.promptInput) {
		const userInput = await vscode.window.showInputBox({
			prompt: request.inputPrompt ?? `Arguments for ${request.tool}`,
			value: request.defaultInput ?? '',
		});
		if (userInput === undefined) {
			return false;
		}
		if (userInput.trim()) {
			args.push(...userInput.trim().split(/\s+/));
		}
	}
	const outcome = await runLogged(request.tool, args, root, { reveal: true });
	return reportOutcome(request.label, outcome);
}

export async function openWorkspaceFile(target?: OpenFileTarget | string): Promise<void> {
	const root = getWorkspaceRoot();
	if (!root || !target) {
		return;
	}
	const resolved: OpenFileTarget =
		typeof target === 'string'
			? { absolutePath: path.join(root, target), displayPath: target, exists: fs.existsSync(path.join(root, target)) }
			: target;
	if (!fs.existsSync(resolved.absolutePath)) {
		void vscode.window.showInformationMessage(`${resolved.displayPath} (missing)`);
		return;
	}
	const doc = await vscode.workspace.openTextDocument(resolved.absolutePath);
	await vscode.window.showTextDocument(doc, { preview: false });
}

export async function openUrl(url?: string): Promise<void> {
	if (!url) {
		return;
	}
	try {
		await vscode.env.openExternal(vscode.Uri.parse(url));
	} catch (error) {
		void vscode.window.showErrorMessage(`Cannot open URL: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function pickWorkspaceFileForSetting(settingKey: string, extensions: string[]): Promise<void> {
	const root = getWorkspaceRoot();
	if (!root) {
		void vscode.window.showInformationMessage('Please open a workspace folder first.');
		return;
	}
	const selected = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		defaultUri: vscode.Uri.file(root),
		filters: { Files: extensions },
	});
	if (!selected || selected.length === 0) {
		return;
	}
	const relative = toWorkspacePath(root, selected[0].fsPath);
	await vscode.workspace.getConfiguration().update(settingKey, relative, vscode.ConfigurationTarget.Workspace);
}

export async function pickLibxrConfigPath(): Promise<void> {
	const root = getWorkspaceRoot();
	if (!root) {
		void vscode.window.showInformationMessage('Please open a workspace folder first.');
		return;
	}
	const candidates = discoverUserLibxrConfigs(root);
	if (candidates.length === 0) {
		void vscode.window.showInformationMessage('No LibXR YAML config found under User/ (name must include "libxr").');
		return;
	}
	const current = getWorkspaceRelativeConfig('xrobot.libxr.configPath', 'User/libxr_config.yaml');
	const items: vscode.QuickPickItem[] = candidates.map((c) => ({ label: c, description: c === current ? 'current' : undefined }));
	const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select current LibXR config file' });
	if (!picked || picked.label === current) {
		return;
	}
	await vscode.workspace.getConfiguration().update('xrobot.libxr.configPath', picked.label, vscode.ConfigurationTarget.Workspace);
	await runLibxrGenerateCodeFromCurrent();
}

export function registerWatchers(context: vscode.ExtensionContext, refreshAll: () => void): void {
	const root = getWorkspaceRoot();
	if (!root) {
		return;
	}

	// Inputs of `xrobot describe` (configs, requests, sources, lock, generated header, the
	// entry source with its XR_REGISTER lines) and of the LibXR view.
	const patterns = [
		'*.ioc',
		// The SysConfig header of an MSPM0 project (the root, sysconfig/, or a level or two down).
		'{,*/,*/*/,*/*/*/}ti_msp_dl_config.h',
		'Modules/modules.yaml',
		'Modules/sources.yaml',
		'xrobot.lock',
		'User/**/*.{yaml,yml}',
		'User/**/*.{c,cc,cpp,cxx,hpp}',
	];

	for (const p of patterns) {
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, p));
		watcher.onDidChange(refreshAll);
		watcher.onDidCreate(refreshAll);
		watcher.onDidDelete(refreshAll);
		context.subscriptions.push(watcher);
	}

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('xrobot')) {
				refreshAll();
			}
		}),
	);
}
