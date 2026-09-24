import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isCollection, parseDocument, stringify as stringifyYaml } from 'yaml';
import { asRecord, parseYamlSafe } from '../yaml/yamlStore';
import { hasUsableXrobotConfig } from './xrobotConfigUtils';
import { discoverUserLibxrConfigs, discoverUserXrobotConfigs } from './workspaceConfigDiscovery';
import {
	XROBOT_ENTRY_HEADER,
	XROBOT_LOCK_FILE,
	buildDescribeArgs,
	buildGenMainArgs,
	buildInstanceAddArgs,
	buildInstanceRemoveArgs,
	buildInstanceSetArgs,
	buildSetupArgs,
	changedEntryInputs,
	describeSummary,
	formatCommandLine,
	isCppIdentifier,
	parseDescribeOutput,
	previewTree,
	shortCommit,
	type DescribeInstance,
	type DescribeResult,
	type NamedValue,
	type ValueTree,
	type XrobotPaths,
} from './describeModel';
import { editInstanceInteractively, type InstanceEditTarget } from './instanceEditor';
import {
	MIRROR_NONE_LABEL,
	PRIORITY_UNSET_LABEL,
	REMOTE_VERSION_DEFAULT_LABEL,
	REMOTE_VERSION_QUICKPICK_CLEAR,
} from '../uiText';

export type CliRunRequest = {
	label: string;
	cmd: string;
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

export type TreeNode = GroupNode | FileNode | YamlValueNode | ActionNode | UrlNode | MessageNode | OpNode;

type GroupNode = {
	type: 'group';
	label: string;
	children: TreeNode[];
	expanded?: boolean;
	description?: string;
	iconId?: string;
	tooltip?: string;
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

type WorkspaceContext = {
	root: string;
	iocFiles: string[];
	selectedIoc?: string;
	platform: 'stm32' | 'unknown';
	libxrConfigRel: string;
	libxrConfigAbs: string;
	appMainRel: string;
	appMainAbs: string;
	libxrConfigCandidates: string[];
	hasLibxrConfig: boolean;
	xrobotConfigRel: string;
	xrobotConfigAbs: string;
	xrobotConfigCandidates: string[];
	hasXrobotConfig: boolean;
};

type GitRemoteRef = {
	name: string;
	kind: 'branch' | 'tag';
	sortTime?: number;
	timeText?: string;
};

type RefQuickPickItem = vscode.QuickPickItem & {
	refName?: string;
};

export const outputChannel = vscode.window.createOutputChannel('XRobot');
export const PROTECTED_SOURCE_URL = 'https://xrobot.work/xrobot-modules/index.yaml';

export function isProtectedSourceUrl(url: string): boolean {
	return url === PROTECTED_SOURCE_URL
		|| url === 'https://xrobot-org.github.io/xrobot-modules/index.yaml';
}
export { isLikelyXrobotConfig } from './xrobotConfigUtils';
export { discoverUserLibxrConfigs, discoverUserXrobotConfigs } from './workspaceConfigDiscovery';

// Provider: LibXR view tree
export class LibxrTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
	public readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

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
			return this.buildRoot(ctx);
		}

		if (element.type === 'group') {
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

	private buildRoot(ctx: WorkspaceContext): TreeNode[] {
		if (ctx.platform !== 'stm32') {
			return [messageNode('Unsupported platform (currently only STM32 with *.ioc in workspace root).')];
		}

		const platformItem: TreeNode =
			ctx.platform === 'stm32' && ctx.selectedIoc
				? fileNode(
						`Platform: [STM32] ${path.basename(ctx.selectedIoc)}`,
						path.join(ctx.root, ctx.selectedIoc),
						ctx.selectedIoc,
						'none',
				  )
				: messageNode('Platform: [Unknown] (need *.ioc in workspace root)');

		if (!ctx.hasLibxrConfig) {
			return [
				platformItem,
				groupNode(
					'Actions',
					[
						actionNode('Configure CubeMX (xr_cubemx_cfg)', {
							label: 'xr_cubemx_cfg',
							cmd: 'xr_cubemx_cfg',
							args: ['-d', '.'],
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

		const systemItem = this.buildSystemItem(ctx);
		const flashLayoutNodes = this.buildFlashLayoutNodes(ctx);
		const flashSummary = this.buildFlashLayoutSummary(ctx);
		const flashLabel = flashSummary ? `Flash Layout: ${flashSummary}` : 'Flash Layout';

		return [
			platformItem,
			systemItem,
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

	private buildFlashLayoutSummary(ctx: WorkspaceContext): string | undefined {
		const rootObj = this.readLibxrConfigRoot(ctx);
		if (!rootObj) {
			return undefined;
		}
		const flash = asRecord(rootObj.FlashLayout);
		if (!flash) {
			return undefined;
		}
		const model = flash.model !== undefined ? String(flash.model) : undefined;
		const size = flash.flash_size_kb !== undefined ? String(flash.flash_size_kb) : undefined;
		if (model && size) {
			return `${model} ${size}KB`;
		}
		return model ?? (size ? `${size}KB` : undefined);
	}

	private buildFlashLayoutNodes(ctx: WorkspaceContext): TreeNode[] {
		const rootObj = this.readLibxrConfigRoot(ctx);
		if (!rootObj) {
			return [messageNode(`${ctx.libxrConfigRel} (missing or invalid)`)];
		}
		const flash = asRecord(rootObj.FlashLayout);
		if (!flash) {
			return [messageNode('(missing) FlashLayout')];
		}

		const model = flash.model !== undefined ? String(flash.model) : 'unknown';
		const base = flash.flash_base !== undefined ? String(flash.flash_base) : 'unknown';
		const size = flash.flash_size_kb !== undefined ? String(flash.flash_size_kb) : 'unknown';
		const nodes: TreeNode[] = [
			messageNode(`Model: ${model}`),
			messageNode(`Base: ${base}`),
			messageNode(`Size: ${size} KB`),
		];

		const sectors = Array.isArray(flash.sectors) ? flash.sectors : [];
		if (sectors.length === 0) {
			nodes.push(messageNode('(empty) sectors'));
			return nodes;
		}

		const sectorNodes: TreeNode[] = [];
		for (const raw of sectors) {
			const s = asRecord(raw);
			if (!s) {
				continue;
			}
			const idx = s.index !== undefined ? String(s.index) : '?';
			const addr = s.address !== undefined ? String(s.address) : '?';
			const sizeKb = s.size_kb !== undefined ? String(s.size_kb) : '?';
			sectorNodes.push(messageNode(`S${idx}: ${addr} (${sizeKb} KB)`));
		}
		nodes.push(groupNode('Sectors', sectorNodes.length > 0 ? sectorNodes : [messageNode('(empty) sectors')], false));
		return nodes;
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
		const withXrobot = ctx.hasXrobotConfig;

		if (ctx.platform === 'stm32') {
			nodes.push(
				actionNode('Configure CubeMX (xr_cubemx_cfg)', {
					label: 'xr_cubemx_cfg',
					cmd: 'xr_cubemx_cfg',
					args: withXrobot ? ['-d', '.', '--xrobot'] : ['-d', '.'],
				}),
			);
			nodes.push(
				actionNode('Parse IOC (xr_parse_ioc)', {
					label: 'xr_parse_ioc',
					cmd: 'xr_parse_ioc',
					promptInput: true,
					defaultInput: `-d ${iocDir === '' ? '.' : iocDir} -o ${parseIocOut} --verbose`,
					inputPrompt: `Example: -d <CubeMXDir> -o ${parseIocOut} --verbose`,
				}),
				actionNode('Generate STM32 Code (xr_gen_code_stm32)', {
					label: 'xr_gen_code_stm32',
					cmd: 'xr_gen_code_stm32',
					promptInput: true,
					defaultInput: withXrobot
						? `-i ${parseIocOut} -o ${appMainArg} --xrobot --libxr-config ${libxrConfigArg}`
						: `-i ${parseIocOut} -o ${appMainArg} --libxr-config ${libxrConfigArg}`,
					inputPrompt: withXrobot
						? `Example: -i ${parseIocOut} -o ${appMainArg} --xrobot --libxr-config ${libxrConfigArg}`
						: `Example: -i ${parseIocOut} -o ${appMainArg} --libxr-config ${libxrConfigArg}`,
				}),
				actionNode('Show STM32 Flash Info (xr_stm32_flash)', {
					label: 'xr_stm32_flash',
					cmd: 'xr_stm32_flash',
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
		const rootObj = this.readLibxrConfigRoot(ctx);
		if (!rootObj) {
			return undefined;
		}
		const flash = asRecord(rootObj.FlashLayout);
		if (!flash || flash.model === undefined) {
			return undefined;
		}
		return String(flash.model);
	}
}

// Provider: XRobot view tree (driven by xrobot_describe; the extension never reads C++ itself)
export class XrobotTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
	public readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

	refresh(): void {
		invalidateXrobotDescribe();
		this.onDidChangeEmitter.fire(undefined);
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return createTreeItem(element);
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		const ctx = getWorkspaceContext();
		if (!ctx) {
			return [messageNode('Open a workspace folder to use XRobot extension.')];
		}

		if (!element) {
			return this.buildRoot(ctx);
		}

		if (element.type === 'group') {
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

	private async buildRoot(ctx: WorkspaceContext): Promise<TreeNode[]> {
		if (!ctx.hasXrobotConfig) {
			return [
				groupNode(
					'Actions',
					[
						actionNode('Setup Workspace (xrobot_setup)', {
							label: 'xrobot_setup',
							cmd: 'xrobot_setup',
						}),
					],
					false,
				),
			];
		}
		const paths = xrobotPathsFor(ctx);
		const outcome = await awaitXrobotDescribe(paths);
		const describe = outcome.ok ? outcome.value : undefined;
		return [
			groupNode(
				'Status',
				this.buildStatus(outcome),
				false,
				describe ? describeSummary(describe) : 'xrobot_describe failed',
			),
			groupNode('Current Workspace', this.buildCurrentWorkspace(ctx, describe), false),
			groupNode('Modules', this.buildModules(ctx, describe), false),
			groupNode('Sources', this.buildSources(ctx), false),
			groupNode('Actions', this.buildActions(paths), false),
		];
	}

	private buildStatus(outcome: DescribeOutcome): TreeNode[] {
		if (!outcome.ok) {
			return [
				messageNode(`xrobot_describe failed: ${outcome.error}`, undefined, { iconId: 'error', tooltip: outcome.error }),
				messageNode('Needs the xrobot package with xrobot_describe; see "XRobot" output', undefined, { iconId: 'info' }),
			];
		}
		const describe = outcome.value;
		const lock = describe.lock;
		const lockChildren: TreeNode[] = [];
		if (!lock.present) {
			lockChildren.push(messageNode(`${lock.path} absent; run Update lock (xrobot_setup --update)`, undefined, { iconId: 'warning' }));
		}
		for (const mod of lock.modules) {
			const head = mod.head && mod.head !== mod.commit ? `, head ${shortCommit(mod.head)}` : '';
			lockChildren.push(
				messageNode(mod.id, `${shortCommit(mod.commit)} ${mod.status}${head}`, {
					iconId: statusIconId(mod.status),
					tooltip: `${mod.id}\nlocked: ${mod.commit}\nhead: ${mod.head ?? '(not checked out)'}`,
				}),
			);
		}
		if (lock.present && lock.modules.length === 0) {
			lockChildren.push(messageNode('(empty) lock'));
		}

		const entry = describe.entry;
		const changed = changedEntryInputs(entry);
		const entryLabel =
			entry.status === 'stale' && changed.length > 0
				? `Entry header: stale (${changed.map((i) => `${i.kind} ${i.path}`).join(', ')} changed)`
				: `Entry header: ${entry.status}`;
		const entryChildren: TreeNode[] = entry.inputs.map((input) =>
			messageNode(`${input.kind}: ${input.path}`, input.status, {
				iconId: statusIconId(input.status),
				tooltip: `recorded: ${input.recorded ?? '-'}\ncurrent: ${input.current ?? '-'}`,
			}),
		);
		if (entry.status === 'missing' || entry.status === 'unstamped') {
			entryChildren.push(messageNode('run Regenerate entry (xrobot_gen_main)', undefined, { iconId: 'info' }));
		}

		const diagnosticNodes: TreeNode[] = describe.diagnostics.map((d) =>
			messageNode(`${d.scope}: ${d.message}`, d.severity, {
				iconId: d.severity === 'error' ? 'error' : 'warning',
				tooltip: `[${d.severity}] ${d.scope}\n${d.message}`,
			}),
		);
		const errorCount = describe.diagnostics.filter((d) => d.severity === 'error').length;

		return [
			groupNode(`Lock: ${lock.status}`, lockChildren.length > 0 ? lockChildren : [messageNode('(empty)')], false, lock.path, {
				iconId: statusIconId(lock.status),
			}),
			groupNode(entryLabel, entryChildren.length > 0 ? entryChildren : [messageNode('(no stamp inputs)')], false, entry.path, {
				iconId: statusIconId(entry.status),
			}),
			groupNode(
				'Diagnostics',
				diagnosticNodes.length > 0 ? diagnosticNodes : [messageNode('no diagnostics', undefined, { iconId: 'pass' })],
				errorCount > 0,
				`${errorCount} errors, ${describe.diagnostics.length - errorCount} warnings`,
				{ iconId: errorCount > 0 ? 'error' : describe.diagnostics.length > 0 ? 'warning' : 'pass' },
			),
		];
	}

	private buildCurrentWorkspace(ctx: WorkspaceContext, describe: DescribeResult | undefined): TreeNode[] {
		const instanceChildren = this.buildInstanceNodes(ctx, describe);
		const settingsChildren = this.buildSettingsNodes(ctx);
		const configCandidates = ctx.xrobotConfigCandidates.map((rel) =>
			fileNode(rel, path.join(ctx.root, rel), rel, false),
		);
		const instanceOps = [
			opNode('add instance (xrobot_instance add)', 'xrobot.addModuleInstance', [], undefined, 'add'),
			...instanceChildren,
		];
		const currentConfigChildren: TreeNode[] = [
			opNode('switch current config', 'xrobot.pickXrobotConfigPath', [], undefined, 'edit'),
			groupNode('Settings', settingsChildren.length > 0 ? settingsChildren : [messageNode('(empty)')], true),
			groupNode('Instances', instanceOps, true),
		];

		return [
			groupNode(`Current Config: ${ctx.xrobotConfigRel}`, currentConfigChildren, true),
			groupNode('Config Files', configCandidates.length > 0 ? configCandidates : [messageNode('(no config files found)')], false),
		];
	}

	private buildModules(ctx: WorkspaceContext, describe: DescribeResult | undefined): TreeNode[] {
		const repoChildren = this.buildRepoNodes(ctx, describe);
		return [
			groupNode('Repos', repoChildren.length > 0 ? repoChildren : [messageNode('(empty)')], true),
		];
	}

	private buildSettingsNodes(ctx: WorkspaceContext): TreeNode[] {
		const configPath = ctx.xrobotConfigAbs;
		const parsed = parseYamlSafe(configPath);
		if (!parsed.ok) {
			return [messageNode(`Parse error: ${parsed.error}`)];
		}
		const settings = asRecord(asRecord(parsed.value)?.settings) ?? {};
		const nodes = toYamlValueNodes(settings, 0, configPath, ['settings'], true);
		if (!Object.prototype.hasOwnProperty.call(settings, 'monitor_sleep_ms')) {
			nodes.push(
				opNode(
					'monitor_sleep_ms',
					'xrobot.editYamlScalar',
					[configPath, ['settings', 'monitor_sleep_ms']],
					'default 1000',
					'symbol-field',
				),
			);
		}
		return nodes;
	}

	private buildRepoNodes(ctx: WorkspaceContext, describe: DescribeResult | undefined): TreeNode[] {
		const modulesPath = path.join(ctx.root, 'Modules', 'modules.yaml');
		const nodes: TreeNode[] = [opNode('add repo', 'xrobot.addRepo', [], undefined, 'add')];
		if (!fs.existsSync(modulesPath)) {
			nodes.push(messageNode('Modules/modules.yaml (missing)'));
			return nodes;
		}

		const parsed = parseYamlSafe(modulesPath);
		if (!parsed.ok) {
			nodes.push(messageNode(`Parse error: ${parsed.error}`));
			return nodes;
		}

		const obj = asRecord(parsed.value);
		const modules = Array.isArray(obj?.modules) ? obj?.modules : [];
		modules.forEach((item, index) => {
			const spec = moduleRepoString(item);
			const parsedSpec = parseRepoSpec(spec);
			const repoChildren: TreeNode[] = [
				opNode(`repo: ${parsedSpec.repo}`, 'xrobot.editRepoName', [index], undefined, 'edit'),
				opNode(
					`version: ${parsedSpec.version ?? REMOTE_VERSION_DEFAULT_LABEL}`,
					'xrobot.editRepoVersion',
					[index],
					undefined,
					'versions',
				),
				opNode('delete', 'xrobot.deleteRepo', [index], undefined, 'trash'),
			];
			const locked = describe?.lock.modules.find((m) => m.id === parsedSpec.repo);
			if (locked) {
				repoChildren.push(
					messageNode(`locked: ${shortCommit(locked.commit)}`, locked.status, { iconId: statusIconId(locked.status) }),
				);
			}
			const described = describe?.modules[parsedSpec.repo];
			const headerPath = described?.header
				? path.join(ctx.root, described.header)
				: findLocalModuleHeader(ctx.root, parsedSpec.repo);
			if (headerPath && fs.existsSync(headerPath)) {
				repoChildren.push(fileNode('module header', headerPath, toWorkspacePath(ctx.root, headerPath), 'none'));
			} else {
				repoChildren.push(messageNode('module source not found locally; run xrobot_setup --frozen'));
			}
			if (described?.error) {
				repoChildren.push(messageNode(`interface error: ${described.error}`, undefined, { iconId: 'error', tooltip: described.error }));
			}
			nodes.push(
				groupNode(
					parsedSpec.repo,
					repoChildren,
					false,
				),
			);
		});
		return nodes;
	}

	private buildInstanceNodes(ctx: WorkspaceContext, describe: DescribeResult | undefined): TreeNode[] {
		const instances = describe ? describe.instances : readYamlInstances(ctx.xrobotConfigAbs);
		if (!instances) {
			return [messageNode(`${ctx.xrobotConfigRel} (missing or invalid)`)];
		}
		return instances.map((instance) => {
			const module = describe?.modules[instance.module];
			const children: TreeNode[] = [];
			if (module?.header) {
				const headerAbs = path.join(ctx.root, module.header);
				children.push(
					fileNode(`module: ${instance.module}`, headerAbs, module.header, 'none', { description: module.class }),
				);
			} else {
				children.push(
					messageNode(
						`module: ${instance.module}`,
						describe ? 'not in locked sources' : undefined,
						{ iconId: describe ? 'warning' : 'package' },
					),
				);
			}
			children.push(opNode(`id: ${instance.id}`, 'xrobot.editModuleInstance', [instance.id, { kind: 'id' }], 'rename', 'edit'));

			const templateParams = module?.template_parameters ?? [];
			const templateCount = Math.max(templateParams.length, instance.template_args.length);
			if (templateCount > 0) {
				const templateNodes: TreeNode[] = [];
				for (let i = 0; i < templateCount; i += 1) {
					const name = templateParams[i]?.name ?? `#${i}`;
					templateNodes.push(
						opNode(
							`${name}: ${previewTree(instance.template_args[i] ?? null)}`,
							'xrobot.editModuleInstance',
							[instance.id, { kind: 'template', index: i }],
							templateParams[i]?.type,
							'symbol-type-parameter',
						),
					);
				}
				children.push(groupNode('template_args', templateNodes, false));
			}

			const argNodes: TreeNode[] = instance.args.map((arg) => this.buildArgNode(instance, arg));
			if ((module?.constructors?.length ?? 0) > 1) {
				argNodes.push(
					opNode('switch constructor', 'xrobot.editModuleInstance', [instance.id, { kind: 'constructor' }], 'resets args', 'list-ordered'),
				);
			}
			children.push(groupNode('args', argNodes.length > 0 ? argNodes : [messageNode('(no args)')], false));
			children.push(opNode('delete instance', 'xrobot.deleteModuleInstance', [instance.id], undefined, 'trash'));
			return groupNode(instance.id, children, false, module?.class ?? instance.module, { iconId: 'symbol-class' });
		});
	}

	private buildArgNode(instance: DescribeInstance, arg: NamedValue): TreeNode {
		const names = Object.keys(arg);
		const name = names.length === 1 ? names[0] : '?';
		const value = arg[name];
		const edit: InstanceEditTarget = { kind: 'arg', name };
		if (value !== null && typeof value === 'object') {
			return groupNode(
				name,
				[
					opNode(`edit ${name}`, 'xrobot.editModuleInstance', [instance.id, edit], undefined, 'edit'),
					...toYamlValueNodes(value, 0),
				],
				false,
				previewTree(value),
				{ iconId: 'symbol-structure', tooltip: previewTree(value, 2000) },
			);
		}
		return opNode(`${name}: ${previewTree(value)}`, 'xrobot.editModuleInstance', [instance.id, edit], undefined, 'symbol-field');
	}

	private buildSources(ctx: WorkspaceContext): TreeNode[] {
		const nodes: TreeNode[] = [opNode('add source', 'xrobot.addSource', [], undefined, 'add')];
		const sourcesPath = path.join(ctx.root, 'Modules', 'sources.yaml');

		const parsedSources = parseSourcesFile(ctx.root, sourcesPath);
		if (parsedSources.error) {
			nodes.push(messageNode(parsedSources.error));
		}

		const combinedSources: SourceItem[] = [...parsedSources.items];
		const knownLocalPaths = new Set(
			combinedSources
				.filter((s): s is Extract<SourceItem, { kind: 'local' }> => s.kind === 'local')
				.map((s) => s.absolutePath.toLowerCase()),
		);
		for (const indexItem of discoverLocalIndexSources(ctx.root)) {
			if (!knownLocalPaths.has(indexItem.absolutePath.toLowerCase())) {
				combinedSources.push(indexItem);
			}
		}

		if (combinedSources.length === 0 && !parsedSources.error) {
			nodes.push(messageNode('(empty) sources'));
			return nodes;
		}

		for (const [idx, src] of combinedSources.entries()) {
			const children: TreeNode[] = [];
			if (src.kind === 'remote') {
				if (isProtectedSourceUrl(src.url)) {
					children.push(messageNode(`priority: ${src.priority ?? PRIORITY_UNSET_LABEL}`));
					children.push(messageNode(`url: ${src.url}`));
					children.push(messageNode(`mirror: ${src.mirror ?? MIRROR_NONE_LABEL}`));
					children.push(messageNode('protected source (cannot modify/delete)'));
					children.push(urlNode('open url', src.url));
				} else {
					children.push(
						opNode(
							`priority: ${src.priority ?? PRIORITY_UNSET_LABEL}`,
							'xrobot.editSourcePriority',
							[idx],
							undefined,
							'edit',
						),
					);
					children.push(opNode(`url: ${src.url}`, 'xrobot.editSourceUrl', [idx], undefined, 'edit'));
					children.push(
						opNode(
							`mirror: ${src.mirror ?? MIRROR_NONE_LABEL}`,
							'xrobot.editSourceMirror',
							[idx],
							undefined,
							'edit',
						),
					);
					children.push(urlNode('open url', src.url));
					children.push(opNode('delete source', 'xrobot.deleteSource', [idx], undefined, 'trash'));
				}
				nodes.push(groupNode(sourceDisplayLabel(src), children, false, sourceSummary(src)));
			} else {
				children.push(
					opNode(
						`priority: ${src.priority ?? PRIORITY_UNSET_LABEL}`,
						'xrobot.editSourcePriority',
						[idx],
						undefined,
						'edit',
					),
				);
				children.push(opNode(`url: ${src.displayPath}`, 'xrobot.editSourceUrl', [idx], undefined, 'edit'));
				children.push(fileNode('open file', src.absolutePath, src.displayPath, false));
				children.push(
					opNode(
						`mirror: ${src.mirror ?? src.mirrorOf ?? MIRROR_NONE_LABEL}`,
						'xrobot.editSourceMirror',
						[idx],
						undefined,
						'edit',
					),
				);
				children.push(opNode('delete source', 'xrobot.deleteSource', [idx], undefined, 'trash'));
				nodes.push(groupNode(sourceDisplayLabel(src), children, false, sourceSummary(src)));
			}
		}
		return nodes;
	}

	private buildActions(paths: XrobotPaths): TreeNode[] {
		return [
			actionNode('Setup Workspace (xrobot_setup)', {
				label: 'xrobot_setup',
				cmd: 'xrobot_setup',
				args: buildSetupArgs(paths),
			}),
			actionNode('Resolve locked sources (xrobot_setup --frozen)', {
				label: 'xrobot_setup --frozen',
				cmd: 'xrobot_setup',
				args: buildSetupArgs(paths, 'frozen'),
			}),
			actionNode('Update lock (xrobot_setup --update)', {
				label: 'xrobot_setup --update',
				cmd: 'xrobot_setup',
				args: buildSetupArgs(paths, 'update'),
			}),
			actionNode('Regenerate entry (xrobot_gen_main)', {
				label: 'xrobot_gen_main',
				cmd: 'xrobot_gen_main',
				args: buildGenMainArgs(paths),
			}),
			actionNode('Init Modules (xrobot_init_mod)', {
				label: 'xrobot_init_mod',
				cmd: 'xrobot_init_mod',
				promptInput: true,
				defaultInput: '--config Modules/modules.yaml --directory Modules --sources Modules/sources.yaml',
			}),
			opNode('Create Module', 'xrobot.createModuleWizard', [], undefined, 'new-file'),
		];
	}
}

function createTreeItem(node: TreeNode): vscode.TreeItem {
	if (node.type === 'group') {
		const item = new vscode.TreeItem(
			node.label,
			node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = node.description ?? `${node.children.length} items`;
		item.tooltip = node.tooltip;
		item.iconPath = new vscode.ThemeIcon(node.iconId ?? groupIconId(node.label));
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
			arguments: [
				{
					absolutePath: node.absolutePath,
					displayPath: node.displayPath,
					exists: node.exists,
				} as OpenFileTarget,
			],
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
		item.command = {
			command: 'xrobot.runCli',
			title: 'Run CLI',
			arguments: [node.runRequest],
		};
		return item;
	}

	if (node.type === 'op') {
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.description = node.description;
		item.iconPath = new vscode.ThemeIcon(node.iconId ?? 'edit');
		item.command = {
			command: node.command,
			title: node.label,
			arguments: node.args ?? [],
		};
		return item;
	}

	if (node.type === 'url') {
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.description = node.description;
		item.tooltip = node.url;
		item.iconPath = new vscode.ThemeIcon('link-external');
		item.command = {
			command: 'xrobot.openUrl',
			title: 'Open URL',
			arguments: [node.url],
		};
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
			const filtered: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(rootObj)) {
				if (k === 'SYSTEM' || k === 'FlashLayout') {
					continue;
				}
				filtered[k] = v;
			}
			return toYamlValueNodes(filtered, 0, node.absolutePath, [], true);
		}
	}
	return toYamlValueNodes(parsed.value, 0, node.absolutePath, [], false);
}

function yamlChildrenForValue(node: YamlValueNode): TreeNode[] {
	if (!canExpandYamlValue(node.value) || node.depth >= 3) {
		return [];
	}
	return toYamlValueNodes(
		node.value,
		node.depth,
		node.filePath,
		node.keyPath ?? [],
		node.editable ?? false,
	);
}

function toYamlValueNodes(
	value: unknown,
	depth: number,
	filePath?: string,
	basePath: Array<string | number> = [],
	editable = false,
): TreeNode[] {
	if (Array.isArray(value)) {
		return value.slice(0, 50).map((item, idx) => {
			const sourceView = normalizeSourceItemForView(item);
			if (sourceView) {
				return yamlNode(`source #${idx}`, sourceView, depth + 1, filePath, [...basePath, idx], editable);
			}
			const sourceLabel = formatSourceArrayItemLabel(item, idx);
			return yamlNode(sourceLabel ?? `[${idx}]`, item, depth + 1, filePath, [...basePath, idx], editable);
		});
	}
	const obj = asRecord(value);
	if (obj) {
		return Object.entries(obj).map(([k, v]) => yamlNode(k, v, depth + 1, filePath, [...basePath, k], editable));
	}
	return [];
}

function formatSourceArrayItemLabel(item: unknown, index: number): string | undefined {
	const obj = asRecord(item);
	if (!obj || typeof obj.url !== 'string') {
		return undefined;
	}
	const priority =
		typeof obj.priority === 'number' || typeof obj.priority === 'string'
			? ` (priority: ${obj.priority})`
			: '';
	return `source #${index}: ${obj.url}${priority}`;
}

function normalizeSourceItemForView(item: unknown): Record<string, unknown> | undefined {
	const obj = asRecord(item);
	if (!obj || typeof obj.url !== 'string') {
		return undefined;
	}

	const mirrorRaw = obj.mirror ?? obj.mirror_of;
	const mirror =
		typeof mirrorRaw === 'string' && mirrorRaw.trim().length > 0
			? mirrorRaw
			: MIRROR_NONE_LABEL;
	const priority =
		typeof obj.priority === 'number' || typeof obj.priority === 'string'
			? obj.priority
			: PRIORITY_UNSET_LABEL;

	return {
		priority,
		url: obj.url,
		mirror,
	};
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
		const url = typeof obj.url === 'string' ? obj.url : undefined;
		const priority = obj.priority;
		if (url) {
			const shortUrl = url.length > 48 ? `${url.slice(0, 45)}...` : url;
			const pri =
				typeof priority === 'number' || typeof priority === 'string'
					? `, priority: ${priority}`
					: '';
			return `url: ${shortUrl}${pri}`;
		}

		const id = obj.id !== undefined ? String(obj.id) : undefined;
		const name = obj.name !== undefined ? String(obj.name) : undefined;
		if (id || name) {
			return `id: ${id ?? '-'}, name: ${name ?? '-'}`;
		}

		const keys = Object.keys(obj);
		return keys.length > 0
			? `keys: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}`
			: 'Object(0)';
	}
	return String(value);
}

function groupNode(
	label: string,
	children: TreeNode[],
	expanded = false,
	description?: string,
	options?: { iconId?: string; tooltip?: string },
): GroupNode {
	return { type: 'group', label, children, expanded, description, iconId: options?.iconId, tooltip: options?.tooltip };
}

function sourceSummary(source: SourceItem): string {
	const pri = source.priority ?? PRIORITY_UNSET_LABEL;
	const mirrorValue =
		source.kind === 'local'
			? source.mirror ?? source.mirrorOf
			: source.mirror;
	if (mirrorValue) {
		return `[pri:${pri}] [M:${mirrorValue}]`;
	}
	const raw = source.kind === 'remote' ? source.url : source.displayPath;
	return `[pri:${pri}] [${tailTwoSegments(raw)}]`;
}

function sourceDisplayLabel(source: SourceItem): string {
	const pri = source.priority ?? PRIORITY_UNSET_LABEL;
	const mirrorValue = source.kind === 'local' ? source.mirror ?? source.mirrorOf : source.mirror;
	if (mirrorValue) {
		return `[${pri}] M:${mirrorValue}`;
	}
	const raw = source.kind === 'remote' ? source.url : source.displayPath;
	const name = tailTwoSegments(raw);
	const short = name.endsWith('/index.yaml') ? name.replace('/index.yaml', '') : name;
	return `[${pri}] ${short}`;
}

function tailTwoSegments(raw: string): string {
	const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
	const parts = normalized.split('/').filter((s) => s.length > 0);
	if (parts.length <= 2) {
		return parts.join('/');
	}
	return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function fileNode(
	label: string,
	absolutePath: string,
	displayPath: string,
	yamlMode: boolean | 'auto' | 'force' | 'none' = 'auto',
	options?: { description?: string; contextValue?: string },
): FileNode {
	const exists = fs.existsSync(absolutePath);
	const normalizedMode =
		yamlMode === true ? 'force' : yamlMode === false ? 'auto' : yamlMode;
	const yamlExpandable =
		normalizedMode === 'force'
			? true
			: normalizedMode === 'none'
				? false
				: /\.(yaml|yml)$/i.test(displayPath);
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

function opNode(
	label: string,
	command: string,
	args: unknown[] = [],
	description?: string,
	iconId?: string,
): OpNode {
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
		case 'unstamped':
		case 'absent':
			return 'warning';
		case 'missing':
			return 'error';
		default:
			return 'info';
	}
}

function groupIconId(label: string): string {
	switch (label) {
		case 'Current Workspace':
			return 'root-folder-opened';
		case 'Modules':
			return 'package';
		case 'Sources':
			return 'repo';
		case 'Actions':
			return 'tools';
		case 'Repos':
			return 'repo-clone';
		case 'Instances':
			return 'symbol-class';
		case 'Settings':
			return 'settings-gear';
		case 'Status':
			return 'pulse';
		case 'args':
		case 'template_args':
			return 'symbol-parameter';
		case 'Config Files':
			return 'files';
		case 'Source Manager (xrobot_src_man)':
			return 'source-control';
		default:
			if (label.startsWith('Source ')) {
				return 'list-tree';
			}
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
	if (node.label === 'Config File' || node.label === 'Current Config') {
		return 'json';
	}
	if (node.label === 'App Main') {
		return 'file-code';
	}
	if (node.label.startsWith('url: ')) {
		return 'link';
	}
	if (node.yamlExpandable) {
		return 'json';
	}
	return 'file';
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

export function getWorkspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getWorkspaceContext(): WorkspaceContext | undefined {
	const root = getWorkspaceRoot();
	if (!root) {
		return undefined;
	}
	const iocFiles = detectIocFiles(root);
	const selectedIoc = resolveIocFile(root, iocFiles);
	const libxrConfig = resolveLibxrConfig(root);
	const appMainRel = getWorkspaceRelativeConfig('xrobot.libxr.appMainPath', 'User/app_main.cpp');
	const xrobotConfig = resolveXrobotConfig(root);
	return {
		root,
		iocFiles,
		selectedIoc,
		platform: selectedIoc ? 'stm32' : 'unknown',
		libxrConfigRel: libxrConfig.selectedRel,
		libxrConfigAbs: path.join(root, libxrConfig.selectedRel),
		libxrConfigCandidates: libxrConfig.candidates,
		hasLibxrConfig: fs.existsSync(path.join(root, libxrConfig.selectedRel)),
		appMainRel,
		appMainAbs: path.join(root, appMainRel),
		xrobotConfigRel: xrobotConfig.selectedRel,
		xrobotConfigAbs: path.join(root, xrobotConfig.selectedRel),
		xrobotConfigCandidates: xrobotConfig.candidates,
		hasXrobotConfig: hasUsableXrobotConfig(path.join(root, xrobotConfig.selectedRel)),
	};
}

function detectIocFiles(root: string): string[] {
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

function resolveXrobotConfig(root: string): { selectedRel: string; candidates: string[] } {
	const candidates = discoverUserXrobotConfigs(root);
	const configured = getWorkspaceRelativeConfig('xrobot.xrobot.configPath', 'User/xrobot.yaml');
	if (candidates.includes(configured)) {
		return { selectedRel: configured, candidates };
	}
	if (candidates.includes('User/xrobot.yaml')) {
		return { selectedRel: 'User/xrobot.yaml', candidates };
	}
	if (candidates.length > 0) {
		return { selectedRel: candidates[0], candidates };
	}
	return { selectedRel: configured, candidates: [] };
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

type SourceItem =
	| { kind: 'remote'; url: string; priority?: number; mirror?: string }
	| {
			kind: 'local';
			absolutePath: string;
			displayPath: string;
			priority?: number;
			namespace?: string;
			mirrorOf?: string;
			mirror?: string;
	  };

function parseSourcesFile(root: string, sourcesPath: string): { items: SourceItem[]; error?: string } {
	if (!fs.existsSync(sourcesPath)) {
		return { items: [], error: 'Modules/sources.yaml (missing)' };
	}

	const parsed = parseYamlSafe(sourcesPath);
	if (!parsed.ok) {
		return { items: [], error: `Parse error: ${parsed.error}` };
	}

	const obj = asRecord(parsed.value);
	const list = Array.isArray(obj?.sources) ? obj.sources : [];
	const items: SourceItem[] = [];
	for (const entry of list) {
		const e = asRecord(entry);
		const url = e ? String(e.url ?? '').trim() : typeof entry === 'string' ? entry.trim() : '';
		if (!url) {
			continue;
		}
		const parsedPriority = Number(e?.priority);
		const priority = Number.isFinite(parsedPriority) ? parsedPriority : undefined;
		const mirrorRaw = e ? e.mirror ?? e.mirror_of : undefined;
		const mirror = typeof mirrorRaw === 'string' && mirrorRaw.trim() ? mirrorRaw.trim() : undefined;
		if (/^https?:\/\//i.test(url)) {
			items.push({ kind: 'remote', url, priority, mirror });
		} else {
			const abs = resolveLocalSourcePath(root, sourcesPath, url);
			const meta = readIndexMeta(abs);
			items.push({
				kind: 'local',
				absolutePath: abs,
				displayPath: toWorkspacePath(root, abs),
				priority,
				namespace: meta?.namespace,
				mirrorOf: meta?.mirrorOf,
				mirror,
			});
		}
	}

	items.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
	return { items };
}

function resolveLocalSourcePath(root: string, sourcesPath: string, value: string): string {
	const trimmed = value.trim();
	if (path.isAbsolute(trimmed)) {
		return trimmed;
	}
	if (trimmed.startsWith('./') || trimmed.startsWith('../')) {
		return path.resolve(path.dirname(sourcesPath), trimmed);
	}
	return path.resolve(root, trimmed);
}

function discoverLocalIndexSources(root: string): Extract<SourceItem, { kind: 'local' }>[] {
	const modulesDir = path.join(root, 'Modules');
	if (!fs.existsSync(modulesDir)) {
		return [];
	}
	const nodes: Extract<SourceItem, { kind: 'local' }>[] = [];
	for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
		if (!entry.isFile()) {
			continue;
		}
		const name = entry.name.toLowerCase();
		if (!name.includes('index') || (!name.endsWith('.yaml') && !name.endsWith('.yml'))) {
			continue;
		}
		const abs = path.join(modulesDir, entry.name);
		const display = toWorkspacePath(root, abs);
		const meta = readIndexMeta(abs);
		nodes.push({
			kind: 'local',
			absolutePath: abs,
			displayPath: display,
			priority: undefined,
			namespace: meta?.namespace,
			mirrorOf: meta?.mirrorOf,
		});
	}
	return nodes;
}

function moduleRepoString(item: unknown): string {
	if (typeof item === 'string') {
		return item;
	}
	const obj = asRecord(item);
	if (!obj) {
		return String(item);
	}
	if (typeof obj.repo === 'string') {
		return obj.repo;
	}
	if (typeof obj.name === 'string') {
		return obj.name;
	}
	return JSON.stringify(obj);
}

export function toWorkspacePath(root: string, abs: string): string {
	const rel = path.relative(root, abs).replace(/\\/g, '/');
	return rel.startsWith('..') ? abs : rel;
}

function readIndexMeta(indexPath: string): { namespace?: string; mirrorOf?: string } | undefined {
	if (!fs.existsSync(indexPath)) {
		return undefined;
	}
	const parsed = parseYamlSafe(indexPath);
	if (!parsed.ok) {
		return undefined;
	}
	const obj = asRecord(parsed.value);
	if (!obj) {
		return undefined;
	}
	return {
		namespace: typeof obj.namespace === 'string' ? obj.namespace : undefined,
		mirrorOf: typeof obj.mirror_of === 'string' ? obj.mirror_of : undefined,
	};
}

function findLocalModuleHeader(root: string, repoSpec: string): string | undefined {
	const parts = repoSpec.split('/');
	const moduleName = parts[parts.length - 1];
	if (!moduleName) {
		return undefined;
	}
	// Locked sources live in Modules/<owner>/<Repo>; older workspaces used Modules/<Repo>.
	const moduleDirs = [path.join(root, 'Modules', ...parts.filter((p) => p.length > 0)), path.join(root, 'Modules', moduleName)];
	const headerCandidates = moduleDirs.flatMap((moduleDir) => [
		path.join(moduleDir, `${moduleName}.hpp`),
		path.join(moduleDir, `${moduleName}.h`),
	]);
	return headerCandidates.find((candidate) => fs.existsSync(candidate));
}

export async function editYamlScalar(filePath: string, keyPath: Array<string | number>): Promise<void> {
	// Edit through the YAML document model so comments and layout of the rest survive.
	let doc: ReturnType<typeof parseDocument>;
	try {
		doc = parseDocument(fs.readFileSync(filePath, 'utf8'));
	} catch (error) {
		vscode.window.showErrorMessage(`Cannot load YAML: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (doc.errors.length > 0) {
		vscode.window.showErrorMessage(`Cannot edit ${filePath}: ${doc.errors[0].message}`);
		return;
	}
	const current = doc.getIn(keyPath);
	if (isCollection(current)) {
		vscode.window.showInformationMessage('Only scalar values are editable.');
		return;
	}
	const input = await vscode.window.showInputBox({
		prompt: `Edit ${keyPath.join('.')}`,
		value: current === undefined || current === null ? '' : String(current),
	});
	if (input === undefined) {
		return;
	}
	doc.setIn(keyPath, parseScalarInput(input));
	try {
		fs.writeFileSync(filePath, doc.toString(), 'utf8');
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to write ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (normalizePath(filePath) === normalizePath(libxrConfigPath())) {
		await runLibxrGenerateCodeFromCurrent();
	}
	if (normalizePath(filePath) === normalizePath(xrobotConfigPath())) {
		await runXrobotGenerateMainFromCurrent();
	}
}

export async function addRepoEntry(): Promise<void> {
	const candidates = await listModuleCandidatesFromSources();
	const pickItems: vscode.QuickPickItem[] = [
		...candidates.map((c) => ({ label: c })),
		{ label: '$(edit) Manual input...', description: 'Enter repo spec manually' },
	];
	const picked = await vscode.window.showQuickPick(pickItems, {
		placeHolder: 'Select module from current sources (or manual input)',
	});
	if (!picked) {
		return;
	}
	let spec = picked.label;
	if (picked.label.includes('Manual input')) {
		const manual = await vscode.window.showInputBox({
			prompt: 'New repo spec',
			placeHolder: 'xrobot-org/BlinkLED or xrobot-org/BlinkLED@master',
		});
		if (!manual || !manual.trim()) {
			return;
		}
		spec = manual.trim();
	}
	await runCli({
		label: 'xrobot_add_mod',
		cmd: 'xrobot_add_mod',
		args: [spec.trim(), '--config', 'Modules/modules.yaml'],
	});
}

export async function editRepoName(index: number): Promise<void> {
	const modulesPath = modulesYamlPath();
	const root = ensureRootWithArray(modulesPath, 'modules');
	if (!root) {
		return;
	}
	const items = root.modules as unknown[];
	const current = parseRepoSpec(moduleRepoString(items[index]));
	const next = await vscode.window.showInputBox({ prompt: 'Repo name', value: current.repo });
	if (!next || !next.trim()) {
		return;
	}
	// Fallback to direct YAML write because xrobot CLI currently has no "edit repo entry" command.
	items[index] = buildRepoSpec(next.trim(), current.version);
	writeYamlRoot(modulesPath, root);
}

export async function editRepoVersion(index: number): Promise<void> {
	const modulesPath = modulesYamlPath();
	const root = ensureRootWithArray(modulesPath, 'modules');
	if (!root) {
		return;
	}
	const items = root.modules as unknown[];
	const current = parseRepoSpec(moduleRepoString(items[index]));
	const remote = await resolveRepoRemote(current.repo);
	const refs = await fetchGitRemoteRefs(remote);
	if (!refs) {
		vscode.window.showErrorMessage(`Cannot load tags/branches from ${remote}. Check git and network access.`);
		return;
	}
	if (refs.length === 0) {
		vscode.window.showInformationMessage(`No tag/branch found for ${current.repo}.`);
		return;
	}
	const picks: RefQuickPickItem[] = [
		{ label: REMOTE_VERSION_QUICKPICK_CLEAR, description: 'Use default branch latest commit', refName: undefined },
		...refs.map((ref) => ({
			label: ref.name,
			description: ref.kind === 'tag' ? `[tag]${ref.timeText ? ` ${ref.timeText}` : ''}` : '[branch]',
			refName: ref.name,
		})),
	];
	const picked = await vscode.window.showQuickPick(picks, {
		placeHolder: `Select version for ${current.repo}`,
	});
	if (!picked) {
		return;
	}
	// Fallback to direct YAML write because xrobot CLI currently has no "edit repo version" command.
	items[index] = buildRepoSpec(current.repo, picked.refName);
	writeYamlRoot(modulesPath, root);
}

export async function deleteRepo(index: number): Promise<void> {
	const modulesPath = modulesYamlPath();
	const root = ensureRootWithArray(modulesPath, 'modules');
	if (!root) {
		return;
	}
	const items = root.modules as unknown[];
	if (index < 0 || index >= items.length) {
		return;
	}
	// Fallback to direct YAML write because xrobot CLI currently has no "remove repo entry" command.
	items.splice(index, 1);
	writeYamlRoot(modulesPath, root);
}

export async function addSourceEntry(): Promise<void> {
	const url = await vscode.window.showInputBox({ prompt: 'Source URL or local path' });
	if (!url || !url.trim()) {
		return;
	}
	const priInput = await vscode.window.showInputBox({ prompt: 'Priority (optional)', value: '' });
	const args = ['add-source', url.trim(), '--sources', 'Modules/sources.yaml'];
	if (priInput && priInput.trim()) {
		const n = Number(priInput.trim());
		if (!Number.isFinite(n)) {
			vscode.window.showErrorMessage('Priority must be a number.');
			return;
		}
		args.push('--priority', String(n));
	}
	await runCli({
		label: 'xrobot_src_man add-source',
		cmd: 'xrobot_src_man',
		args,
	});
}

export async function editSourceUrl(index: number): Promise<void> {
	const root = ensureRootWithArray(sourcesYamlPath(), 'sources');
	if (!root) {
		return;
	}
	const source = getSourceObject(root.sources as unknown[], index);
	if (!source) {
		return;
	}
	const current = String(source.url ?? '');
	if (isProtectedSourceUrl(current)) {
		vscode.window.showInformationMessage('This default source is protected and cannot be modified.');
		return;
	}
	const next = await vscode.window.showInputBox({ prompt: 'Source URL/path', value: current });
	if (!next || !next.trim()) {
		return;
	}
	// Fallback to direct YAML write because xrobot_src_man has no "edit-source" command.
	source.url = next.trim();
	writeYamlRoot(sourcesYamlPath(), root);
}

export async function editSourcePriority(index: number): Promise<void> {
	const root = ensureRootWithArray(sourcesYamlPath(), 'sources');
	if (!root) {
		return;
	}
	const source = getSourceObject(root.sources as unknown[], index);
	if (!source) {
		return;
	}
	const next = await vscode.window.showInputBox({
		prompt: 'Priority (empty to clear)',
		value: source.priority === undefined ? '' : String(source.priority),
	});
	if (next === undefined) {
		return;
	}
	if (!next.trim()) {
		delete source.priority;
	} else {
		const n = Number(next.trim());
		if (!Number.isFinite(n)) {
			vscode.window.showErrorMessage('Priority must be a number.');
			return;
		}
		source.priority = n;
	}
	// Fallback to direct YAML write because xrobot_src_man has no "edit-source" command.
	writeYamlRoot(sourcesYamlPath(), root);
}

export async function editSourceMirror(index: number): Promise<void> {
	const root = ensureRootWithArray(sourcesYamlPath(), 'sources');
	if (!root) {
		return;
	}
	const source = getSourceObject(root.sources as unknown[], index);
	if (!source) {
		return;
	}
	const current = typeof source.mirror === 'string' ? source.mirror : typeof source.mirror_of === 'string' ? source.mirror_of : '';
	const next = await vscode.window.showInputBox({
		prompt: 'Mirror (empty to clear)',
		value: current,
	});
	if (next === undefined) {
		return;
	}
	if (!next.trim()) {
		delete source.mirror;
		delete source.mirror_of;
	} else {
		source.mirror = next.trim();
		delete source.mirror_of;
	}
	// Fallback to direct YAML write because xrobot_src_man has no "edit-source" command.
	writeYamlRoot(sourcesYamlPath(), root);
}

export async function deleteSource(index: number): Promise<void> {
	const root = ensureRootWithArray(sourcesYamlPath(), 'sources');
	if (!root) {
		return;
	}
	const items = root.sources as unknown[];
	const source = getSourceObject(items, index);
	if (!source) {
		return;
	}
	if (isProtectedSourceUrl(String(source.url ?? ''))) {
		vscode.window.showInformationMessage('This default source is protected and cannot be deleted.');
		return;
	}
	// Fallback to direct YAML write because xrobot_src_man has no "remove-source" command.
	items.splice(index, 1);
	writeYamlRoot(sourcesYamlPath(), root);
}

type XrobotEditState = {
	ctx: WorkspaceContext;
	paths: XrobotPaths;
	describe: DescribeResult;
};

async function loadXrobotEditState(): Promise<XrobotEditState | undefined> {
	const ctx = getWorkspaceContext();
	if (!ctx) {
		vscode.window.showInformationMessage('Please open a workspace folder first.');
		return undefined;
	}
	if (!ctx.hasXrobotConfig) {
		vscode.window.showInformationMessage(`No usable XRobot config (${ctx.xrobotConfigRel}); run xrobot_setup first.`);
		return undefined;
	}
	const paths = xrobotPathsFor(ctx);
	const outcome = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: 'XRobot: reading project (xrobot_describe)' },
		() => awaitXrobotDescribe(paths),
	);
	if (!outcome.ok) {
		vscode.window.showErrorMessage(`xrobot_describe failed: ${outcome.error}`);
		return undefined;
	}
	return { ctx, paths, describe: outcome.value };
}

async function pickInstance(describe: DescribeResult, placeHolder: string): Promise<DescribeInstance | undefined> {
	if (describe.instances.length === 0) {
		vscode.window.showInformationMessage(`No instances in ${describe.config}.`);
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		describe.instances.map((instance) => ({
			label: instance.id,
			description: instance.module,
			instance,
		})),
		{ placeHolder, matchOnDescription: true },
	);
	return picked?.instance;
}

// Instance edits always go through xrobot_instance (it validates and keeps YAML
// comments); the entry header is regenerated only after a successful write.
async function runXrobotInstance(paths: XrobotPaths, label: string, args: string[]): Promise<boolean> {
	const code = await runCli({ label, cmd: 'xrobot_instance', args });
	if (code !== 0) {
		void vscode.window.showErrorMessage(`${label} failed${code === undefined ? '' : ` (exit ${code})`}; see "XRobot" output.`);
		return false;
	}
	await runXrobotGenerateMain(paths);
	return true;
}

export async function addModuleInstance(): Promise<void> {
	const state = await loadXrobotEditState();
	if (!state) {
		return;
	}
	const { describe, paths } = state;
	const modules = Object.values(describe.modules)
		.filter((m) => m.standalone)
		.sort((a, b) => a.id.localeCompare(b.id));
	if (modules.length === 0) {
		vscode.window.showInformationMessage('No instantiable Modules in the locked sources; add a repo and run xrobot_setup.');
		return;
	}
	const picked = await vscode.window.showQuickPick(
		modules.map((m) => ({
			label: m.id,
			description: m.class,
			detail: m.error ? `interface error: ${m.error}` : undefined,
			module: m,
		})),
		{ placeHolder: 'Select the Module to instantiate', matchOnDescription: true },
	);
	if (!picked) {
		return;
	}
	const taken = new Set(describe.instances.map((i) => i.id));
	const id = await vscode.window.showInputBox({
		prompt: `Instance id for ${picked.module.id} (optional; empty = automatic ${picked.module.class.toLowerCase()}_<n>)`,
		validateInput: (value) => {
			const trimmed = value.trim();
			if (!trimmed) {
				return undefined;
			}
			if (!isCppIdentifier(trimmed)) {
				return 'Instance id must be a C++ identifier';
			}
			return taken.has(trimmed) ? `Instance id ${trimmed} already exists` : undefined;
		},
	});
	if (id === undefined) {
		return;
	}
	await runXrobotInstance(paths, 'xrobot_instance add', buildInstanceAddArgs(paths.config, picked.module.id, id));
}

export async function editModuleInstance(instanceId?: string, target?: InstanceEditTarget): Promise<void> {
	const state = await loadXrobotEditState();
	if (!state) {
		return;
	}
	const { describe, paths } = state;
	const instance =
		(instanceId ? describe.instances.find((i) => i.id === instanceId) : undefined) ??
		(await pickInstance(describe, 'Select the instance to edit'));
	if (!instance) {
		return;
	}
	const values = await editInstanceInteractively(describe, instance, target);
	if (!values) {
		return;
	}
	await runXrobotInstance(paths, 'xrobot_instance set', buildInstanceSetArgs(paths.config, instance.id, values));
}

export async function deleteModuleInstance(instanceId?: string): Promise<void> {
	let id = instanceId;
	let paths: XrobotPaths | undefined;
	if (!id) {
		const state = await loadXrobotEditState();
		if (!state) {
			return;
		}
		paths = state.paths;
		id = (await pickInstance(state.describe, 'Select the instance to delete'))?.id;
	} else {
		const ctx = getWorkspaceContext();
		paths = ctx ? xrobotPathsFor(ctx) : undefined;
	}
	if (!id || !paths) {
		return;
	}
	const confirmed = await vscode.window.showWarningMessage(
		`Remove instance ${id} from ${paths.config}?`,
		{ modal: true },
		'Remove',
	);
	if (confirmed !== 'Remove') {
		return;
	}
	await runXrobotInstance(paths, 'xrobot_instance remove', buildInstanceRemoveArgs(paths.config, id));
}

// Fallback listing when xrobot_describe is unavailable: display only, never edited.
function readYamlInstances(configPath: string): DescribeInstance[] | undefined {
	const root = readYamlRoot(configPath);
	if (!root) {
		return undefined;
	}
	const modules = Array.isArray(root.modules) ? root.modules : [];
	return modules.map((entry, index) => {
		const item = asRecord(entry) ?? {};
		return {
			id: item.id !== undefined ? String(item.id) : `#${index}`,
			module: item.module !== undefined ? String(item.module) : '(no module)',
			class: null,
			template_args: Array.isArray(item.template_args) ? (item.template_args as ValueTree[]) : [],
			args: Array.isArray(item.args) ? (item.args as NamedValue[]) : [],
		};
	});
}

export async function createModuleWizard(): Promise<void> {
	const className = await vscode.window.showInputBox({ prompt: 'Module class name (required)', placeHolder: 'MyModule' });
	if (!className || !className.trim()) {
		return;
	}
	const desc = await vscode.window.showInputBox({ prompt: 'Description (optional)', value: '' });
	if (desc === undefined) {
		return;
	}
	const ctor = await vscode.window.showInputBox({
		prompt: 'Constructor parameter declarations (C++, separated by ";", optional)',
		placeHolder: 'LibXR::GPIO& led; uint32_t blink_cycle = 250',
		value: '',
	});
	if (ctor === undefined) {
		return;
	}
	const template = await vscode.window.showInputBox({
		prompt: 'Template parameter declarations (C++, separated by ";", optional)',
		placeHolder: 'typename ChassisType',
		value: '',
	});
	if (template === undefined) {
		return;
	}
	const depends = await vscode.window.showInputBox({
		prompt: 'Depends modules (space-separated, optional)',
		value: '',
	});
	if (depends === undefined) {
		return;
	}
	const out = await vscode.window.showInputBox({
		prompt: 'Output directory',
		value: 'Modules',
	});
	if (!out || !out.trim()) {
		return;
	}

	const splitDeclarations = (text: string): string[] =>
		text
			.split(';')
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	const args: string[] = [className.trim()];
	if (desc.trim()) {
		args.push('--desc', desc.trim());
	}
	for (const decl of splitDeclarations(ctor)) {
		args.push('--constructor', decl);
	}
	for (const decl of splitDeclarations(template)) {
		args.push('--template', decl);
	}
	if (depends.trim()) {
		args.push('--depends', ...depends.trim().split(/\s+/));
	}
	args.push('--out', out.trim());

	await runCli({
		label: 'xrobot_create_mod',
		cmd: 'xrobot_create_mod',
		args,
	});
}

export function parseRepoSpec(spec: string): { repo: string; version?: string } {
	const at = spec.lastIndexOf('@');
	if (at <= 0) {
		return { repo: spec };
	}
	return { repo: spec.slice(0, at), version: spec.slice(at + 1) || undefined };
}

export function buildRepoSpec(repo: string, version?: string): string {
	return version ? `${repo}@${version}` : repo;
}

export async function resolveRepoRemote(repo: string): Promise<string> {
	const trimmed = repo.trim();
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
		return trimmed;
	}
	if (trimmed.endsWith('.git')) {
		return trimmed;
	}
	if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
		const resolved = await resolveRepoRemoteFromSources(trimmed);
		if (resolved) {
			return resolved;
		}
		return `https://github.com/${trimmed}.git`;
	}
	return trimmed;
}

async function resolveRepoRemoteFromSources(modid: string): Promise<string | undefined> {
	const res = await runCommandCapture('xrobot_src_man', ['get', modid]);
	if (!res.ok) {
		return undefined;
	}
	for (const line of res.stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (/^https?:\/\/\S+$/i.test(trimmed) || /^git@[^:]+:\S+$/i.test(trimmed)) {
			return trimmed;
		}
	}
	return undefined;
}

export async function fetchGitRemoteRefs(remote: string): Promise<GitRemoteRef[] | undefined> {
	return new Promise((resolve) => {
		const child = spawn('git', ['ls-remote', '--heads', '--tags', remote], {
			shell: true,
			env: getCliEnv(),
		});
		let stdout = '';
		let stderr = '';

		child.stdout.on('data', (d: Buffer | string) => {
			stdout += d.toString();
		});
		child.stderr.on('data', (d: Buffer | string) => {
			stderr += d.toString();
		});
		child.on('error', () => resolve(undefined));
		child.on('close', (code) => {
			if (code !== 0) {
				outputChannel.appendLine(`[git] ls-remote failed for ${remote}: ${stderr.trim()}`);
				resolve(undefined);
				return;
			}
			const refs = parseGitRefs(stdout);
			resolve(refs);
		});
	});
}

export function parseGitRefs(raw: string): GitRemoteRef[] {
	const values = new Map<string, GitRemoteRef>();
	for (const line of raw.split(/\r?\n/)) {
		const ref = line.split('\t')[1];
		if (!ref) {
			continue;
		}
		if (ref.startsWith('refs/heads/')) {
			const name = ref.slice('refs/heads/'.length);
			if (name) {
				values.set(`branch:${name}`, {
					name,
					kind: 'branch',
				});
			}
			continue;
		}
		if (ref.startsWith('refs/tags/')) {
			const tag = ref.slice('refs/tags/'.length).replace(/\^\{\}$/, '');
			if (tag) {
				const parsedTime = parseRefTimestamp(tag);
				values.set(`tag:${tag}`, {
					name: tag,
					kind: 'tag',
					sortTime: parsedTime?.sortTime,
					timeText: parsedTime?.text,
				});
			}
		}
	}
	return Array.from(values.values()).sort(compareGitRefs);
}

function compareGitRefs(a: GitRemoteRef, b: GitRemoteRef): number {
	if (a.kind !== b.kind) {
		return a.kind === 'branch' ? -1 : 1;
	}
	const aTime = a.sortTime;
	const bTime = b.sortTime;
	const aHasTime = typeof aTime === 'number';
	const bHasTime = typeof bTime === 'number';
	if (aHasTime && bHasTime && aTime !== bTime) {
		return bTime - aTime;
	}
	if (aHasTime !== bHasTime) {
		return aHasTime ? -1 : 1;
	}
	return a.name.localeCompare(b.name);
}

function parseRefTimestamp(name: string): { sortTime: number; text: string } | undefined {
	const match = name.match(/(\d{8})[-_](\d{6})(?!.*\d)/);
	if (!match) {
		return undefined;
	}
	const date = match[1];
	const time = match[2];
	const year = Number(date.slice(0, 4));
	const month = Number(date.slice(4, 6));
	const day = Number(date.slice(6, 8));
	const hour = Number(time.slice(0, 2));
	const minute = Number(time.slice(2, 4));
	const second = Number(time.slice(4, 6));
	if ([year, month, day, hour, minute, second].some((value) => !Number.isFinite(value))) {
		return undefined;
	}
	return {
		sortTime: Date.UTC(year, month - 1, day, hour, minute, second),
		text: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`,
	};
}

export function modulesYamlPath(): string {
	const root = getWorkspaceRoot() ?? '';
	return path.join(root, 'Modules', 'modules.yaml');
}

export function sourcesYamlPath(): string {
	const root = getWorkspaceRoot() ?? '';
	return path.join(root, 'Modules', 'sources.yaml');
}

export function libxrConfigPath(): string {
	const root = getWorkspaceRoot() ?? '';
	const rel = getWorkspaceRelativeConfig('xrobot.libxr.configPath', 'User/libxr_config.yaml');
	return path.join(root, rel);
}

export function xrobotConfigPath(): string {
	const root = getWorkspaceRoot() ?? '';
	const rel = getWorkspaceRelativeConfig('xrobot.xrobot.configPath', 'User/xrobot.yaml');
	return path.join(root, rel);
}

function stm32ParsedConfigArg(): string {
	return './.config.yaml';
}

function normalizePath(p: string): string {
	return path.resolve(p).toLowerCase();
}

export function xrobotPathsFor(ctx: WorkspaceContext): XrobotPaths {
	return {
		root: ctx.root,
		config: ctx.xrobotConfigRel,
		registerSource: fs.existsSync(ctx.appMainAbs) ? ctx.appMainRel : undefined,
		header: XROBOT_ENTRY_HEADER,
		lock: XROBOT_LOCK_FILE,
	};
}

async function runXrobotGenerateMain(paths: XrobotPaths): Promise<void> {
	await runCli({
		label: 'xrobot_gen_main',
		cmd: 'xrobot_gen_main',
		args: buildGenMainArgs(paths),
	});
}

async function runXrobotGenerateMainFromCurrent(): Promise<void> {
	const ctx = getWorkspaceContext();
	if (!ctx) {
		return;
	}
	await runXrobotGenerateMain(xrobotPathsFor(ctx));
}

async function runLibxrGenerateCodeFromCurrent(): Promise<void> {
	const appMainRel = getWorkspaceRelativeConfig('xrobot.libxr.appMainPath', 'User/app_main.cpp').replace(/\\/g, '/');
	const libxrConfigRel = getWorkspaceRelativeConfig('xrobot.libxr.configPath', 'User/libxr_config.yaml').replace(/\\/g, '/');
	const appMainArg = `./${appMainRel.replace(/^\.?\//, '')}`;
	const parseIocOut = stm32ParsedConfigArg();
	const libxrConfigArg = `./${libxrConfigRel.replace(/^\.?\//, '')}`;
	const withXrobot = hasUsableXrobotConfig(xrobotConfigPath());
	const args = ['-i', parseIocOut, '-o', appMainArg, '--libxr-config', libxrConfigArg];
	if (withXrobot) {
		args.splice(4, 0, '--xrobot');
	}
	await runCli({
		label: 'xr_gen_code_stm32',
		cmd: 'xr_gen_code_stm32',
		args,
	});
}

async function runCommandCapture(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const root = getWorkspaceRoot();
		if (!root) {
			resolve({ ok: false, stdout: '', stderr: 'No workspace' });
			return;
		}
		const child = spawn(cmd, args, { cwd: root, shell: true, env: getCliEnv() });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d: Buffer | string) => (stdout += d.toString()));
		child.stderr.on('data', (d: Buffer | string) => (stderr += d.toString()));
		child.on('error', (e) => resolve({ ok: false, stdout, stderr: String(e) }));
		child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
	});
}

async function listModuleCandidatesFromSources(): Promise<string[]> {
	const res = await runCommandCapture('xrobot_src_man', ['list']);
	if (!res.ok) {
		return [];
	}
	const set = new Set<string>();
	for (const line of res.stdout.split(/\r?\n/)) {
		const m = line.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
		if (m) {
			set.add(m[1]);
		}
	}
	return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export function readYamlRoot(filePath: string): Record<string, unknown> | undefined {
	if (!fs.existsSync(filePath)) {
		return undefined;
	}
	const parsed = parseYamlSafe(filePath);
	if (!parsed.ok) {
		return undefined;
	}
	return asRecord(parsed.value);
}

export function writeYamlRoot(filePath: string, root: Record<string, unknown>): void {
	fs.writeFileSync(filePath, stringifyYaml(root), 'utf8');
}

export function ensureRootWithArray(filePath: string, key: string): Record<string, unknown> | undefined {
	const root = readYamlRoot(filePath) ?? {};
	if (!Array.isArray(root[key])) {
		root[key] = [];
	}
	return root;
}

export function getSourceObject(items: unknown[], index: number): Record<string, unknown> | undefined {
	if (index < 0 || index >= items.length) {
		return undefined;
	}
	const obj = asRecord(items[index]);
	if (!obj) {
		return undefined;
	}
	return obj;
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

export function checkCliPrerequisites(): void {
	// Release-time startup diagnostics: report missing runtime dependencies early.
	const errors: string[] = [];
	const pythonCmd = detectPythonCommand();
	const pythonAvailable = pythonCmd ? isPythonAvailable(pythonCmd) : false;
	const hasXrobotCli = isAnyCommandAvailable(['xrobot_setup', 'xrobot_init_mod']);
	const hasLibxrCli = isAnyCommandAvailable(['xr_parse_ioc', 'xr_gen_code_stm32', 'xr_cubemx_cfg']);

	if (!isCommandAvailable('git')) {
		errors.push('Missing tool: git');
	}
	if (!pythonCmd || !pythonAvailable) {
		errors.push('Missing tool: python (python/py/python3.x)');
	}
	if (!isPipAvailable(pythonAvailable ? pythonCmd : undefined)) {
		errors.push('Missing tool: pip (python -m pip unavailable)');
	}
	if (pythonCmd && pythonAvailable && !hasXrobotCli && !hasPipPackage(pythonCmd, 'xrobot')) {
		errors.push('Missing pip package: xrobot');
	}
	if (pythonCmd && pythonAvailable && !hasLibxrCli && !hasPipPackage(pythonCmd, 'libxr')) {
		errors.push('Missing pip package: libxr');
	}
	if (!hasXrobotCli) {
		errors.push('Missing executable in PATH: xrobot CLI (e.g. xrobot_setup)');
	}
	if (!hasLibxrCli) {
		errors.push('Missing executable in PATH: libxr CLI (e.g. xr_parse_ioc / xr_cubemx_cfg)');
	}

	if (errors.length === 0) {
		return;
	}
	outputChannel.appendLine('[ERROR] Dependency check failed:');
	for (const e of errors) {
		outputChannel.appendLine(`[ERROR] ${e}. Please install/configure it.`);
	}
	outputChannel.appendLine('');
	outputChannel.show(true);
	void vscode.window.showWarningMessage(
		`Dependency check failed. See "XRobot" output for details and install hints.`,
	);
}

export function isAnyCommandAvailable(commands: string[]): boolean {
	return commands.some((c) => isCommandAvailable(c));
}

export function isCommandAvailable(commandName: string): boolean {
	const probe = process.platform === 'win32' ? 'where' : 'command';
	const probeArgs = process.platform === 'win32' ? [commandName] : ['-v', commandName];
	const result = spawnSync(probe, probeArgs, {
		shell: true,
		env: getCliEnv(),
		encoding: 'utf8',
	});
	return result.status === 0 && Boolean((result.stdout ?? '').trim());
}

function isExecutablePath(commandName: string): boolean {
	if (!commandName) {
		return false;
	}
	const hasPathSep = commandName.includes('/') || commandName.includes('\\');
	if (!hasPathSep) {
		return false;
	}
	try {
		return fs.existsSync(commandName);
	} catch {
		return false;
	}
}

function isPythonAvailable(commandName: string): boolean {
	if (isExecutablePath(commandName)) {
		return true;
	}
	return isCommandAvailable(commandName);
}

function detectPythonCommand(): string | undefined {
	const configured = vscode.workspace.getConfiguration('xrobot.cli').get<string>('pythonPath', '').trim();
	if (configured) {
		return configured;
	 }

	const candidates = [
		'python',
		'python3',
		'python3.12',
		'python3.11',
		'python3.10',
		'python3.9',
		'python3.8',
		'py',
	];

	for (const candidate of candidates) {
		if (isPythonAvailable(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

function isPipAvailable(pythonCmd: string | undefined): boolean {
	if (!pythonCmd) {
		return false;
	}
	const result = spawnSync(pythonCmd, ['-m', 'pip', '--version'], {
		shell: true,
		env: getCliEnv(),
		encoding: 'utf8',
	});
	return result.status === 0;
}

function hasPipPackage(pythonCmd: string, pkg: string): boolean {
	const result = spawnSync(pythonCmd, ['-m', 'pip', 'show', pkg], {
		shell: true,
		env: getCliEnv(),
		encoding: 'utf8',
	});
	return result.status === 0 && /Name:\s*/i.test(result.stdout ?? '');
}

export async function runCli(request: CliRunRequest): Promise<number | undefined> {
	// Centralized CLI runner used by all actions and post-edit auto-generation hooks.
	// Resolves with the exit code once the process has finished (undefined if it never ran).
	const root = getWorkspaceRoot();
	if (!root) {
		vscode.window.showErrorMessage('Please open a workspace folder first.');
		return undefined;
	}

	const args = [...(request.args ?? [])];
	if (request.promptInput) {
		const userInput = await vscode.window.showInputBox({
			prompt: request.inputPrompt ?? `Arguments for ${request.cmd}`,
			value: request.defaultInput ?? '',
		});
		if (userInput === undefined) {
			return undefined;
		}
		if (userInput.trim()) {
			args.push(...userInput.trim().split(/\s+/));
		}
	}

	outputChannel.appendLine(`$ ${formatCommandLine(request.cmd, args)}`);
	outputChannel.appendLine(`cwd: ${root}`);
	outputChannel.appendLine('----');
	outputChannel.show(true);

	const result = await startCli(request.cmd, args, root, {
		onStdout: (text) => outputChannel.append(text),
		onStderr: (text) => outputChannel.append(text),
	}).done;

	if (result.error) {
		if (result.error.code === 'ENOENT') {
			void vscode.window.showErrorMessage(
				'命令未在 PATH 中，检查 pipx ensurepath 或设置 xrobot.cli.extraPath',
			);
		} else {
			void vscode.window.showErrorMessage(`Run failed: ${result.error.message}`);
		}
		outputChannel.appendLine(`\n[error] ${result.error.message}`);
		outputChannel.appendLine('');
		return undefined;
	}
	outputChannel.appendLine(`\n[exit] ${result.code ?? -1}`);
	outputChannel.appendLine('');
	return result.code ?? undefined;
}

type CliResult = {
	code: number | null;
	stdout: string;
	stderr: string;
	error?: NodeJS.ErrnoException;
	cancelled: boolean;
};

type CliRun = {
	done: Promise<CliResult>;
	cancel: () => void;
};

// Python entry points of the xrobot CLIs, used only when the console script is not
// on PATH but a Python interpreter (xrobot.cli.pythonPath or auto-detected) is.
const XROBOT_PYTHON_ENTRY_POINTS: Record<string, [string, string]> = {
	xrobot_describe: ['xrobot.Describe', 'main'],
	xrobot_instance: ['xrobot.AddModule', 'instance_main'],
	xrobot_gen_main: ['xrobot.GenerateMain', 'main'],
	xrobot_setup: ['xrobot.XRobotSetup', 'main'],
};

// Spawns without a shell: each argument (JSON, C++ text, paths with spaces) reaches the
// tool as one argv element. Commands are looked up on PATH (+ xrobot.cli.extraPath).
function startCli(
	cmd: string,
	args: string[],
	cwd: string,
	handlers?: { onStdout?: (text: string) => void; onStderr?: (text: string) => void },
): CliRun {
	let cancelled = false;
	let current: ReturnType<typeof spawn> | undefined;

	const attempt = (command: string, argv: string[]): Promise<CliResult> =>
		new Promise((resolve) => {
			let stdout = '';
			let stderr = '';
			let settled = false;
			const settle = (result: CliResult): void => {
				if (!settled) {
					settled = true;
					resolve(result);
				}
			};
			const child = spawn(command, argv, { cwd, shell: false, env: getCliEnv() });
			current = child;
			child.stdout?.on('data', (d: Buffer | string) => {
				const text = d.toString();
				stdout += text;
				handlers?.onStdout?.(text);
			});
			child.stderr?.on('data', (d: Buffer | string) => {
				const text = d.toString();
				stderr += text;
				handlers?.onStderr?.(text);
			});
			child.on('error', (error: NodeJS.ErrnoException) => settle({ code: null, stdout, stderr, error, cancelled }));
			child.on('close', (code: number | null) => settle({ code, stdout, stderr, cancelled }));
		});

	const done = (async (): Promise<CliResult> => {
		const first = await attempt(cmd, args);
		const entry = XROBOT_PYTHON_ENTRY_POINTS[cmd];
		if (first.error?.code !== 'ENOENT' || !entry || cancelled) {
			return first;
		}
		const python = detectPythonCommand();
		if (!python) {
			return first;
		}
		const [moduleName, functionName] = entry;
		const bootstrap = `import sys; sys.argv[0] = ${JSON.stringify(cmd)}; from ${moduleName} import ${functionName} as entry; sys.exit(entry())`;
		handlers?.onStderr?.(`[info] ${cmd} not found in PATH; running ${moduleName}:${functionName} with ${python}\n`);
		const second = await attempt(python, ['-c', bootstrap, ...args]);
		return second.error?.code === 'ENOENT' ? first : second;
	})();

	return {
		done,
		cancel: () => {
			cancelled = true;
			current?.kill();
		},
	};
}

type DescribeOutcome =
	| { ok: true; value: DescribeResult }
	| { ok: false; error: string; cancelled?: boolean };

// One xrobot_describe run per refresh: the tree and the edit commands share the result
// until the next refresh (after every edit and on watched file changes).
class XrobotDescribeCache {
	private key: string | undefined;
	private pending: Promise<DescribeOutcome> | undefined;
	private cancelRun: (() => void) | undefined;

	invalidate(): void {
		this.cancelRun?.();
		this.key = undefined;
		this.pending = undefined;
		this.cancelRun = undefined;
	}

	get(paths: XrobotPaths): Promise<DescribeOutcome> {
		const args = buildDescribeArgs(paths);
		const key = args.join('\u0000');
		if (this.pending && this.key === key) {
			return this.pending;
		}
		this.invalidate();
		const run = startCli('xrobot_describe', args, paths.root);
		this.key = key;
		this.cancelRun = run.cancel;
		this.pending = run.done.then((result): DescribeOutcome => {
			if (result.cancelled) {
				return { ok: false, error: 'cancelled', cancelled: true };
			}
			const commandLine = formatCommandLine('xrobot_describe', args);
			if (result.error) {
				outputChannel.appendLine(`[describe] ${commandLine}: ${result.error.message}`);
				return {
					ok: false,
					error: result.error.code === 'ENOENT' ? 'xrobot_describe not found in PATH' : result.error.message,
				};
			}
			if (result.code !== 0) {
				const detail = result.stderr.trim() || `exit ${result.code ?? -1}`;
				outputChannel.appendLine(`[describe] ${commandLine} failed (exit ${result.code ?? -1}): ${detail}`);
				return { ok: false, error: detail.split(/\r?\n/).pop() ?? detail };
			}
			const parsed = parseDescribeOutput(result.stdout);
			if (!parsed.ok) {
				outputChannel.appendLine(`[describe] ${commandLine}: ${parsed.error}`);
			}
			return parsed;
		});
		const pending = this.pending;
		void vscode.window.withProgress({ location: { viewId: 'xrobot.xrobotView' } }, async () => {
			await pending;
		});
		return pending;
	}
}

const xrobotDescribeCache = new XrobotDescribeCache();

export function invalidateXrobotDescribe(): void {
	xrobotDescribeCache.invalidate();
}

// Resolves with the newest run: a run cancelled by a refresh hands over to a run for
// the current workspace state (which may have switched config meanwhile).
async function awaitXrobotDescribe(paths: XrobotPaths): Promise<DescribeOutcome> {
	let current = paths;
	for (;;) {
		const outcome = await xrobotDescribeCache.get(current);
		if (outcome.ok || !outcome.cancelled) {
			return outcome;
		}
		const ctx = getWorkspaceContext();
		if (!ctx || !ctx.hasXrobotConfig) {
			return outcome;
		}
		current = xrobotPathsFor(ctx);
	}
}

export function getCliEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const extraPath = vscode.workspace.getConfiguration('xrobot.cli').get<string>('extraPath', '').trim();
	if (!extraPath) {
		return env;
	}
	const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
	const sep = process.platform === 'win32' ? ';' : ':';
	const current = env[pathKey] ?? '';
	env[pathKey] = current ? `${current}${sep}${extraPath}` : extraPath;
	return env;
}

export async function openWorkspaceFile(target: OpenFileTarget | string): Promise<void> {
	const root = getWorkspaceRoot();
	if (!root) {
		vscode.window.showInformationMessage('Please open a workspace folder first.');
		return;
	}

	const resolved: OpenFileTarget =
		typeof target === 'string'
			? {
					absolutePath: path.join(root, target),
					displayPath: target,
					exists: fs.existsSync(path.join(root, target)),
			  }
			: target;

	if (!resolved.exists || !fs.existsSync(resolved.absolutePath)) {
		vscode.window.showInformationMessage(`${resolved.displayPath} (missing)`);
		return;
	}

	const doc = await vscode.workspace.openTextDocument(resolved.absolutePath);
	await vscode.window.showTextDocument(doc, { preview: false });
}

export async function openUrl(url: string): Promise<void> {
	try {
		await vscode.env.openExternal(vscode.Uri.parse(url));
	} catch (error) {
		void vscode.window.showErrorMessage(`Cannot open URL: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function pickWorkspaceFileForSetting(settingKey: string, extensions: string[]): Promise<void> {
	const root = getWorkspaceRoot();
	if (!root) {
		vscode.window.showInformationMessage('Please open a workspace folder first.');
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

	const chosenFsPath = selected[0].fsPath;
	const relative = toWorkspacePath(root, chosenFsPath);
	await vscode.workspace.getConfiguration().update(settingKey, relative, vscode.ConfigurationTarget.Workspace);
}

export async function pickXrobotConfigPath(): Promise<void> {
	const root = getWorkspaceRoot();
	if (!root) {
		vscode.window.showInformationMessage('Please open a workspace folder first.');
		return;
	}
	const candidates = discoverUserXrobotConfigs(root);
	if (candidates.length === 0) {
		vscode.window.showInformationMessage('No XRobot YAML config found under User/.');
		return;
	}
	const current = getWorkspaceRelativeConfig('xrobot.xrobot.configPath', 'User/xrobot.yaml');
	const items: vscode.QuickPickItem[] = candidates.map((c) => ({
		label: c,
		description: c === current ? 'current' : undefined,
	}));
	const picked = await vscode.window.showQuickPick(
		items,
		{ placeHolder: 'Select current XRobot config file' },
	);
	if (!picked) {
		return;
	}
	if (picked.label === current) {
		return;
	}
	await vscode.workspace.getConfiguration().update('xrobot.xrobot.configPath', picked.label, vscode.ConfigurationTarget.Workspace);
	await runXrobotGenerateMainFromCurrent();
}

export async function pickLibxrConfigPath(): Promise<void> {
	const root = getWorkspaceRoot();
	if (!root) {
		vscode.window.showInformationMessage('Please open a workspace folder first.');
		return;
	}
	const candidates = discoverUserLibxrConfigs(root);
	if (candidates.length === 0) {
		vscode.window.showInformationMessage('No LibXR YAML config found under User/ (name must include "libxr").');
		return;
	}
	const current = getWorkspaceRelativeConfig('xrobot.libxr.configPath', 'User/libxr_config.yaml');
	const items: vscode.QuickPickItem[] = candidates.map((c) => ({
		label: c,
		description: c === current ? 'current' : undefined,
	}));
	const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select current LibXR config file' });
	if (!picked) {
		return;
	}
	if (picked.label === current) {
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

	const patterns = [
		'*.ioc',
		'config.yaml',
		'libxr_config.yaml',
		'User/libxr_config.yaml',
		'app_main.cpp',
		'User/app_main.cpp',
		'User/xrobot_main.hpp',
		'xrobot.lock',
		'Modules/**/*.yml',
		'Modules/**/*.yaml',
		'User/**/*.yml',
		'User/**/*.yaml',
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
			if (
				event.affectsConfiguration('xrobot.libxr.iocFile') ||
				event.affectsConfiguration('xrobot.libxr.configPath') ||
				event.affectsConfiguration('xrobot.libxr.appMainPath') ||
				event.affectsConfiguration('xrobot.xrobot.configPath')
			) {
				refreshAll();
			}
		}),
	);
}
