import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { asRecord, parseYamlSafe } from '../yaml/yamlStore';
import { hasUsableXrobotConfig } from './xrobotConfigUtils';
import { guardedWriteYamlRoot } from './yamlWriteGuard';
import { discoverUserLibxrConfigs, discoverUserXrobotConfigs } from './workspaceConfigDiscovery';
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
export const PROTECTED_SOURCE_URL = 'https://xrobot-org.github.io/xrobot-modules/index.yaml';
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
			groupNode('Hardware Container', this.buildHardwareContainerNodes(ctx), false),
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

	private buildHardwareContainerNodes(ctx: WorkspaceContext): TreeNode[] {
		const rootObj = this.readLibxrConfigRoot(ctx);
		if (!rootObj) {
			return [messageNode(`${ctx.libxrConfigRel} (missing or invalid)`)];
		}
		const aliases = asRecord(rootObj.device_aliases);
		if (!aliases) {
			return [messageNode('(missing) device_aliases')];
		}

		const nodes: TreeNode[] = [];
		for (const [name, raw] of Object.entries(aliases)) {
			const aliasObj = asRecord(raw);
			const children: TreeNode[] = [opNode('add alias', 'xrobot.addHardwareAlias', [name], undefined, 'add')];
			if (aliasObj?.type !== undefined) {
				children.push(messageNode(`type: ${String(aliasObj.type)}`));
			}
			const aliasList = Array.isArray(aliasObj?.aliases) ? aliasObj.aliases.map((a) => String(a)) : [];
			aliasList.forEach((alias, idx) => {
				const aliasChildren: TreeNode[] = [
					opNode('edit alias', 'xrobot.editHardwareAlias', [name, idx], undefined, 'edit'),
				];
				if (aliasList.length > 1) {
					aliasChildren.push(
						opNode('delete alias', 'xrobot.deleteHardwareAlias', [name, idx], undefined, 'trash'),
					);
				}
				children.push(groupNode(`alias: ${alias}`, aliasChildren, false));
			});
			nodes.push(groupNode(name, children.length > 0 ? children : [messageNode('(empty)')], false));
		}

		return nodes.length > 0 ? nodes : [messageNode('(empty) device_aliases')];
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
						? `Example: -i ${parseIocOut} -o ${appMainArg} --xrobot --hw-cntr --libxr-config ${libxrConfigArg}`
						: `Example: -i ${parseIocOut} -o ${appMainArg} --hw-cntr --libxr-config ${libxrConfigArg}`,
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

// Provider: XRobot view tree
export class XrobotTreeProvider implements vscode.TreeDataProvider<TreeNode> {
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
		return [
			groupNode('Current Workspace', this.buildCurrentWorkspace(ctx), false),
			groupNode('Modules', this.buildModules(ctx), false),
			groupNode('Sources', this.buildSources(ctx), false),
			groupNode('Actions', this.buildActions(ctx), false),
		];
	}

	private buildCurrentWorkspace(ctx: WorkspaceContext): TreeNode[] {
		const instanceChildren = this.buildInstanceNodes(ctx);
		const globalSettingsChildren = this.buildGlobalSettingsNodes(ctx);
		const configCandidates = ctx.xrobotConfigCandidates.map((rel) =>
			fileNode(rel, path.join(ctx.root, rel), rel, false),
		);
		const instanceOps = [
			opNode('add instance (xrobot_add_mod)', 'xrobot.addModuleInstance', [], undefined, 'add'),
			...instanceChildren,
		];
		const currentConfigChildren: TreeNode[] = [
			opNode('switch current config', 'xrobot.pickXrobotConfigPath', [], undefined, 'edit'),
			groupNode(
				'Global Settings',
				globalSettingsChildren.length > 0 ? globalSettingsChildren : [messageNode('(empty)')],
				true,
			),
			groupNode('Instances', instanceOps.length > 0 ? instanceOps : [messageNode('(empty)')], true),
		];

		return [
			groupNode(`Current Config: ${ctx.xrobotConfigRel}`, currentConfigChildren, true),
			groupNode('Config Files', configCandidates.length > 0 ? configCandidates : [messageNode('(no config files found)')], false),
		];
	}

	private buildModules(ctx: WorkspaceContext): TreeNode[] {
		const repoChildren = this.buildRepoNodes(ctx);
		return [
			groupNode('Repos', repoChildren.length > 0 ? repoChildren : [messageNode('(empty)')], true),
		];
	}

	private buildGlobalSettingsNodes(ctx: WorkspaceContext): TreeNode[] {
		const configPath = ctx.xrobotConfigAbs;
		if (!fs.existsSync(configPath)) {
			return [messageNode(`${ctx.xrobotConfigRel} (missing)`)];
		}

		const parsed = parseYamlSafe(configPath);
		if (!parsed.ok) {
			return [messageNode(`Parse error: ${parsed.error}`)];
		}

		const rootObj = asRecord(parsed.value);
		const globalSettings = asRecord(rootObj?.global_settings);
		if (!globalSettings) {
			return [messageNode('(missing) global_settings')];
		}

		return toYamlValueNodes(globalSettings, 0, configPath, ['global_settings'], true);
	}

	private buildRepoNodes(ctx: WorkspaceContext): TreeNode[] {
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
			const headerPath = findLocalModuleHeader(ctx.root, parsedSpec.repo);
			if (headerPath) {
				repoChildren.push(fileNode('module header', headerPath, toWorkspacePath(ctx.root, headerPath), 'none'));
				const manifestRoot = readModuleManifestRoot(headerPath);
				if (manifestRoot) {
					repoChildren.push(groupNode('module_manifest', buildModuleManifestNodes(manifestRoot, headerPath), true));
				} else {
					repoChildren.push(messageNode('module manifest parse failed'));
				}
			} else {
				repoChildren.push(messageNode('module source not found locally; run xrobot_init_mod first'));
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

	private buildInstanceNodes(ctx: WorkspaceContext): TreeNode[] {
		const userPath = ctx.xrobotConfigAbs;
		if (!fs.existsSync(userPath)) {
			return [messageNode(`${ctx.xrobotConfigRel} (missing)`)];
		}

		const parsed = parseYamlSafe(userPath);
		if (!parsed.ok) {
			return [messageNode(`Parse error: ${parsed.error}`)];
		}

		const obj = asRecord(parsed.value);
		const modules = Array.isArray(obj?.modules) ? obj?.modules : [];
		const nodes: TreeNode[] = [];

		for (const [index, entry] of modules.entries()) {
			const item = asRecord(entry);
			if (!item) {
				nodes.push(messageNode(String(entry)));
				continue;
			}
			const id = item.id !== undefined ? String(item.id) : '-';
			const name = item.name !== undefined ? String(item.name) : '(no-name)';
			const child: TreeNode[] = [];
			child.push(opNode(`id: ${id}`, 'xrobot.editModuleInstance', [index], undefined, 'edit'));
			child.push(opNode(`name: ${name}`, 'xrobot.editModuleInstance', [index], undefined, 'edit'));
			if (item.constructor_args !== undefined) {
				child.push(
					groupNode(
						'constructor_args',
						toYamlValueNodes(item.constructor_args, 0, userPath, ['modules', index, 'constructor_args'], true),
						true,
					),
				);
			}
			if (item.template_args !== undefined) {
				child.push(
					groupNode(
						'template_args',
						toYamlValueNodes(item.template_args, 0, userPath, ['modules', index, 'template_args'], true),
						true,
					),
				);
			}
			child.push(opNode('delete instance', 'xrobot.deleteModuleInstance', [index], undefined, 'trash'));
			nodes.push(groupNode(`${id} / ${name}`, child.length > 0 ? child : [messageNode('(no args)')]));
		}

		return nodes;
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
				if (src.url === PROTECTED_SOURCE_URL) {
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

	private buildActions(ctx: WorkspaceContext): TreeNode[] {
		return [
			actionNode('Setup Workspace (xrobot_setup)', {
				label: 'xrobot_setup',
				cmd: 'xrobot_setup',
			}),
			actionNode('Init Modules (xrobot_init_mod)', {
				label: 'xrobot_init_mod',
				cmd: 'xrobot_init_mod',
				promptInput: true,
				defaultInput: '--config Modules/modules.yaml --directory Modules --sources Modules/sources.yaml',
			}),
			actionNode('Add Module Instance (xrobot_add_mod)', {
				label: 'xrobot_add_mod',
				cmd: 'xrobot_add_mod',
				promptInput: true,
				defaultInput: `BlinkLED --config ${ctx.xrobotConfigRel}`,
			}),
			actionNode('Generate Main Header (xrobot_gen_main)', {
				label: 'xrobot_gen_main',
				cmd: 'xrobot_gen_main',
				args: ['--output', 'User/xrobot_main.hpp', '--config', ctx.xrobotConfigRel],
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
		item.iconPath = new vscode.ThemeIcon(groupIconId(node.label));
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
	msg.iconPath = new vscode.ThemeIcon(messageIconId(node.label));
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
				if (k === 'device_aliases' || k === 'SYSTEM' || k === 'FlashLayout') {
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

function groupNode(label: string, children: TreeNode[], expanded = false, description?: string): GroupNode {
	return { type: 'group', label, children, expanded, description };
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

function messageNode(label: string, description?: string): MessageNode {
	return { type: 'message', label, description };
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
		case 'Global Settings':
			return 'settings-gear';
		case 'Hardware Container':
			return 'circuit-board';
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
	const moduleDir = path.join(root, 'Modules', moduleName);
	const headerCandidates = [
		path.join(moduleDir, `${moduleName}.hpp`),
		path.join(moduleDir, `${moduleName}.h`),
	];
	return headerCandidates.find((candidate) => fs.existsSync(candidate));
}

function normalizeManifestKeyValueList(value: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(value)) {
		return value.map((item) => ({ ...(asRecord(item) ?? {}) }));
	}
	const obj = asRecord(value);
	if (obj) {
		return Object.entries(obj).map(([k, v]) => ({ [k]: v }));
	}
	if (typeof value === 'string' && value.trim()) {
		return [{ [value.trim()]: '' }];
	}
	return [];
}

function normalizeManifestStringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((item) => String(item));
	}
	if (typeof value === 'string' && value.trim()) {
		return [value.trim()];
	}
	return [];
}

function readModuleManifestRoot(filePath: string): Record<string, unknown> | undefined {
	if (!fs.existsSync(filePath)) {
		return undefined;
	}
	const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
	const match = content.match(/\/\*\s*=== MODULE MANIFEST(?: V2)? ===\s*([\s\S]*?)\s*=== END MANIFEST ===\s*\*\//i);
	if (!match) {
		return undefined;
	}
	try {
		const parsed = parseYaml(match[1]);
		const root = asRecord(parsed);
		if (!root) {
			return undefined;
		}
		root.constructor_args = normalizeManifestKeyValueList(root.constructor_args);
		root.template_args = normalizeManifestKeyValueList(root.template_args);
		root.required_hardware = normalizeManifestStringList(root.required_hardware);
		root.depends = normalizeManifestStringList(root.depends);
		return root;
	} catch {
		return undefined;
	}
}

function writeModuleManifestRoot(filePath: string, root: Record<string, unknown>): boolean {
	if (!fs.existsSync(filePath)) {
		return false;
	}
	const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
	const pattern = /(\/\*\s*=== MODULE MANIFEST(?: V2)? ===\s*)([\s\S]*?)(\s*=== END MANIFEST ===\s*\*\/)/i;
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	if (!pattern.test(content)) {
		return false;
	}
	const manifestBody = stringifyYaml(root).trimEnd().replace(/\n/g, eol);
	const updated = content.replace(pattern, `$1${manifestBody}${eol}$3`);
	fs.writeFileSync(filePath, updated, 'utf8');
	return true;
}

function readEditableRoot(filePath: string): Record<string, unknown> | undefined {
	if (/\.(hpp|h)$/i.test(filePath)) {
		return readModuleManifestRoot(filePath);
	}
	return readYamlRoot(filePath);
}

function writeEditableRoot(filePath: string, root: Record<string, unknown>): boolean {
	if (/\.(hpp|h)$/i.test(filePath)) {
		return writeModuleManifestRoot(filePath, root);
	}
	writeYamlRoot(filePath, root);
	return true;
}

function buildModuleManifestNodes(manifestRoot: Record<string, unknown>, filePath: string): TreeNode[] {
	const nodes: TreeNode[] = [];
	if (Object.prototype.hasOwnProperty.call(manifestRoot, 'module_description')) {
		nodes.push(yamlNode('module_description', manifestRoot.module_description, 0, filePath, ['module_description'], true));
	} else {
		nodes.push(messageNode('(missing) module_description'));
	}
	nodes.push(
		groupNode(
			'constructor_args',
			buildManifestKeyValueSectionNodes(filePath, 'constructor_args', manifestRoot.constructor_args, 'constructor arg'),
			true,
		),
	);
	nodes.push(
		groupNode(
			'template_args',
			buildManifestKeyValueSectionNodes(filePath, 'template_args', manifestRoot.template_args, 'template arg'),
			true,
		),
	);
	nodes.push(
		groupNode(
			'required_hardware',
			buildManifestStringSectionNodes(filePath, 'required_hardware', manifestRoot.required_hardware, 'hardware'),
			true,
		),
	);
	nodes.push(
		groupNode(
			'depends',
			buildManifestStringSectionNodes(filePath, 'depends', manifestRoot.depends, 'dependency'),
			true,
		),
	);
	for (const [key, value] of Object.entries(manifestRoot)) {
		if (['module_description', 'constructor_args', 'template_args', 'required_hardware', 'depends'].includes(key)) {
			continue;
		}
		nodes.push(yamlNode(key, value, 0, filePath, [key], true));
	}
	return nodes;
}

function buildManifestKeyValueSectionNodes(
	filePath: string,
	section: string,
	value: unknown,
	itemLabel: string,
): TreeNode[] {
	const items = normalizeManifestKeyValueList(value);
	const nodes: TreeNode[] = [opNode(`add ${itemLabel}`, 'xrobot.addModuleManifestKeyValue', [filePath, section], undefined, 'add')];
	if (items.length === 0) {
		nodes.push(messageNode('(empty)'));
		return nodes;
	}
	items.forEach((entry, index) => {
		const obj = asRecord(entry);
		if (obj && Object.keys(obj).length === 1) {
			const [key, itemValue] = Object.entries(obj)[0];
			nodes.push(
				groupNode(
					key,
					[
						yamlNode('value', itemValue, 0, filePath, [section, index, key], true),
						opNode('rename key', 'xrobot.renameModuleManifestKey', [filePath, section, index], undefined, 'edit'),
						opNode('delete', 'xrobot.deleteModuleManifestEntry', [filePath, section, index], undefined, 'trash'),
					],
					false,
				),
			);
			return;
		}
		nodes.push(
			groupNode(
				`${itemLabel} #${index}`,
				[
					...toYamlValueNodes(entry, 0, filePath, [section, index], true),
					opNode('delete', 'xrobot.deleteModuleManifestEntry', [filePath, section, index], undefined, 'trash'),
				],
				false,
			),
		);
	});
	return nodes;
}

function buildManifestStringSectionNodes(
	filePath: string,
	section: string,
	value: unknown,
	itemLabel: string,
): TreeNode[] {
	const items = normalizeManifestStringList(value);
	const nodes: TreeNode[] = [opNode(`add ${itemLabel}`, 'xrobot.addModuleManifestString', [filePath, section], undefined, 'add')];
	if (items.length === 0) {
		nodes.push(messageNode('(empty)'));
		return nodes;
	}
	items.forEach((item, index) => {
		nodes.push(
			groupNode(
				item,
				[
					yamlNode('value', item, 0, filePath, [section, index], true),
					opNode('delete', 'xrobot.deleteModuleManifestEntry', [filePath, section, index], undefined, 'trash'),
				],
				false,
			),
		);
	});
	return nodes;
}

export async function editYamlScalar(filePath: string, keyPath: Array<string | number>): Promise<void> {
	const rootObj = readEditableRoot(filePath);
	if (!rootObj) {
		vscode.window.showErrorMessage(`Cannot load editable data: ${filePath}`);
		return;
	}
	const current = getAtPath(rootObj, keyPath);
	if (current !== null && typeof current === 'object') {
		vscode.window.showInformationMessage('Only scalar values are editable.');
		return;
	}
	const input = await vscode.window.showInputBox({
		prompt: `Edit ${keyPath.join('.')}`,
		value: current === undefined ? '' : String(current),
	});
	if (input === undefined) {
		return;
	}
	setAtPath(rootObj, keyPath, parseScalarInput(input));
	if (!writeEditableRoot(filePath, rootObj)) {
		vscode.window.showErrorMessage(`Failed to write editable data: ${filePath}`);
		return;
	}
	if (normalizePath(filePath) === normalizePath(libxrConfigPath())) {
		await runLibxrGenerateCodeFromCurrent();
	}
	if (normalizePath(filePath) === normalizePath(xrobotConfigPath())) {
		await runXrobotGenerateMainFromCurrent();
	}
}

export async function addModuleManifestKeyValue(filePath: string, section: string): Promise<void> {
	const rootObj = readEditableRoot(filePath);
	if (!rootObj) {
		vscode.window.showErrorMessage(`Cannot load editable data: ${filePath}`);
		return;
	}
	const key = await vscode.window.showInputBox({
		prompt: `New key for ${section}`,
		placeHolder: section === 'constructor_args' ? 'blink_cycle' : 'ChassisType',
	});
	if (!key || !key.trim()) {
		return;
	}
	const valueInput = await vscode.window.showInputBox({
		prompt: `Default value for ${key.trim()}`,
		value: '',
	});
	if (valueInput === undefined) {
		return;
	}
	const items = normalizeManifestKeyValueList(rootObj[section]);
	items.push({ [key.trim()]: parseScalarInput(valueInput) });
	rootObj[section] = items;
	if (!writeEditableRoot(filePath, rootObj)) {
		vscode.window.showErrorMessage(`Failed to write editable data: ${filePath}`);
	}
}

export async function addModuleManifestString(filePath: string, section: string): Promise<void> {
	const rootObj = readEditableRoot(filePath);
	if (!rootObj) {
		vscode.window.showErrorMessage(`Cannot load editable data: ${filePath}`);
		return;
	}
	const nextValue = await vscode.window.showInputBox({
		prompt: `New value for ${section}`,
		value: '',
	});
	if (!nextValue || !nextValue.trim()) {
		return;
	}
	const items = normalizeManifestStringList(rootObj[section]);
	items.push(nextValue.trim());
	rootObj[section] = items;
	if (!writeEditableRoot(filePath, rootObj)) {
		vscode.window.showErrorMessage(`Failed to write editable data: ${filePath}`);
	}
}

export async function deleteModuleManifestEntry(filePath: string, section: string, index: number): Promise<void> {
	const rootObj = readEditableRoot(filePath);
	if (!rootObj) {
		vscode.window.showErrorMessage(`Cannot load editable data: ${filePath}`);
		return;
	}
	if (section === 'constructor_args' || section === 'template_args') {
		const items = normalizeManifestKeyValueList(rootObj[section]);
		if (index < 0 || index >= items.length) {
			return;
		}
		items.splice(index, 1);
		rootObj[section] = items;
	} else {
		const items = normalizeManifestStringList(rootObj[section]);
		if (index < 0 || index >= items.length) {
			return;
		}
		items.splice(index, 1);
		rootObj[section] = items;
	}
	if (!writeEditableRoot(filePath, rootObj)) {
		vscode.window.showErrorMessage(`Failed to write editable data: ${filePath}`);
	}
}

export async function renameModuleManifestKey(filePath: string, section: string, index: number): Promise<void> {
	const rootObj = readEditableRoot(filePath);
	if (!rootObj) {
		vscode.window.showErrorMessage(`Cannot load editable data: ${filePath}`);
		return;
	}
	const items = normalizeManifestKeyValueList(rootObj[section]);
	if (index < 0 || index >= items.length) {
		return;
	}
	const obj = asRecord(items[index]);
	if (!obj || Object.keys(obj).length !== 1) {
		vscode.window.showInformationMessage('Only single-key manifest entries can be renamed.');
		return;
	}
	const [currentKey, currentValue] = Object.entries(obj)[0];
	const nextKey = await vscode.window.showInputBox({
		prompt: `Rename key in ${section}`,
		value: currentKey,
	});
	if (!nextKey || !nextKey.trim() || nextKey.trim() === currentKey) {
		return;
	}
	items[index] = { [nextKey.trim()]: currentValue };
	rootObj[section] = items;
	if (!writeEditableRoot(filePath, rootObj)) {
		vscode.window.showErrorMessage(`Failed to write editable data: ${filePath}`);
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
	if (current === PROTECTED_SOURCE_URL) {
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
	if (String(source.url ?? '') === PROTECTED_SOURCE_URL) {
		vscode.window.showInformationMessage('This default source is protected and cannot be deleted.');
		return;
	}
	// Fallback to direct YAML write because xrobot_src_man has no "remove-source" command.
	items.splice(index, 1);
	writeYamlRoot(sourcesYamlPath(), root);
}

type HardwareAliasEditState = {
	root: Record<string, unknown>;
	entry: Record<string, unknown>;
	aliases: string[];
};

function getHardwareAliasEditState(entryKey: string): HardwareAliasEditState | undefined {
	const root = ensureLibxrRootWithDeviceAliases();
	if (!root) {
		return undefined;
	}
	const entry = asRecord((root.device_aliases as Record<string, unknown>)[entryKey]);
	if (!entry) {
		return undefined;
	}
	const aliases = Array.isArray(entry.aliases) ? entry.aliases.map((a) => String(a)) : [];
	return { root, entry, aliases };
}

function hardwareAliasOperation(action: 'add' | 'edit' | 'delete', entryKey: string, aliasIndex?: number): string {
	if (aliasIndex === undefined) {
		return `${action}HardwareAlias(${entryKey})`;
	}
	return `${action}HardwareAlias(${entryKey},${aliasIndex})`;
}

async function persistHardwareAliasEdit(
	state: HardwareAliasEditState,
	entryKey: string,
	action: 'add' | 'edit' | 'delete',
	aliasIndex?: number,
): Promise<boolean> {
	state.entry.aliases = state.aliases;
	const op = hardwareAliasOperation(action, entryKey, aliasIndex);
	const detail = aliasIndex === undefined ? `entry=${entryKey} aliases=${state.aliases.length}` : `entry=${entryKey} index=${aliasIndex} aliases=${state.aliases.length}`;
	outputChannel.appendLine(`[libxr] ${action}HardwareAlias ${detail}`);
	if (!writeLibxrConfigWithValidation(state.root, op)) {
		return false;
	}
	await runLibxrGenerateCodeFromCurrent();
	return true;
}

export async function addHardwareAlias(entryKey: string): Promise<void> {
	const state = getHardwareAliasEditState(entryKey);
	if (!state) {
		return;
	}
	const next = await vscode.window.showInputBox({ prompt: `Add alias to ${entryKey}` });
	if (!next || !next.trim()) {
		return;
	}
	state.aliases.push(next.trim());
	await persistHardwareAliasEdit(state, entryKey, 'add');
}

export async function editHardwareAlias(entryKey: string, aliasIndex: number): Promise<void> {
	const state = getHardwareAliasEditState(entryKey);
	if (!state) {
		return;
	}
	if (aliasIndex < 0 || aliasIndex >= state.aliases.length) {
		return;
	}
	const next = await vscode.window.showInputBox({ prompt: `Edit alias of ${entryKey}`, value: state.aliases[aliasIndex] });
	if (!next || !next.trim()) {
		return;
	}
	state.aliases[aliasIndex] = next.trim();
	await persistHardwareAliasEdit(state, entryKey, 'edit', aliasIndex);
}

export async function deleteHardwareAlias(entryKey: string, aliasIndex: number): Promise<void> {
	const state = getHardwareAliasEditState(entryKey);
	if (!state) {
		return;
	}
	if (state.aliases.length <= 1) {
		vscode.window.showInformationMessage('At least one alias must remain.');
		return;
	}
	if (aliasIndex < 0 || aliasIndex >= state.aliases.length) {
		return;
	}
	state.aliases.splice(aliasIndex, 1);
	await persistHardwareAliasEdit(state, entryKey, 'delete', aliasIndex);
}

export async function addModuleInstance(): Promise<void> {
	const candidates = listLocalModuleCandidates();
	const picked = await vscode.window.showQuickPick(
		[
			...candidates.map((m) => ({ label: m })),
			{ label: '$(edit) Manual input...', description: 'Type module name manually' },
		],
		{
			placeHolder: 'Select module instance target (local modules first)',
		},
	);
	if (!picked) {
		return;
	}
	let target = picked.label;
	if (picked.label.includes('Manual input')) {
		const manual = await vscode.window.showInputBox({
			prompt: 'Module name to instantiate',
			placeHolder: 'BlinkLED',
		});
		if (!manual || !manual.trim()) {
			return;
		}
		target = manual.trim();
	}
	if (!target || !target.trim()) {
		return;
	}
	await runCli({
		label: 'xrobot_add_mod',
		cmd: 'xrobot_add_mod',
		args: [target.trim(), '--config', getWorkspaceRelativeConfig('xrobot.xrobot.configPath', 'User/xrobot.yaml')],
	});
	await runXrobotGenerateMainFromCurrent();
}

export async function editModuleInstance(index: number): Promise<void> {
	const configPath = xrobotConfigPath();
	const root = ensureRootWithArray(configPath, 'modules');
	if (!root) {
		return;
	}
	const modules = root.modules as unknown[];
	if (index < 0 || index >= modules.length) {
		return;
	}
	const instance = asRecord(modules[index]);
	if (!instance) {
		vscode.window.showInformationMessage('Only object instances are editable.');
		return;
	}
	const nextId = await vscode.window.showInputBox({
		prompt: 'Instance id',
		value: instance.id === undefined ? '' : String(instance.id),
	});
	if (nextId === undefined) {
		return;
	}
	const nextName = await vscode.window.showInputBox({
		prompt: 'Module name',
		value: instance.name === undefined ? '' : String(instance.name),
	});
	if (nextName === undefined) {
		return;
	}
	instance.id = nextId.trim() || instance.id;
	instance.name = nextName.trim() || instance.name;
	// Fallback to direct YAML write because xrobot CLI currently has no "edit instance" command.
	writeYamlRoot(configPath, root);
	await runXrobotGenerateMainFromCurrent();
}

export async function deleteModuleInstance(index: number): Promise<void> {
	const configPath = xrobotConfigPath();
	const root = ensureRootWithArray(configPath, 'modules');
	if (!root) {
		return;
	}
	const modules = root.modules as unknown[];
	if (index < 0 || index >= modules.length) {
		return;
	}
	// Fallback to direct YAML write because xrobot CLI currently has no "delete instance" command.
	modules.splice(index, 1);
	writeYamlRoot(configPath, root);
	await runXrobotGenerateMainFromCurrent();
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
	const hw = await vscode.window.showInputBox({ prompt: 'Hardware tags (space-separated, optional)', value: '' });
	if (hw === undefined) {
		return;
	}
	const ctor = await vscode.window.showInputBox({
		prompt: 'Constructor args (space-separated k=v, optional)',
		value: '',
	});
	if (ctor === undefined) {
		return;
	}
	const template = await vscode.window.showInputBox({
		prompt: 'Template args (space-separated k=v, optional)',
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

	const args: string[] = [className.trim()];
	if (desc.trim()) {
		args.push('--desc', desc.trim());
	}
	if (hw.trim()) {
		args.push('--hw', ...hw.trim().split(/\s+/));
	}
	if (ctor.trim()) {
		args.push('--constructor', ...ctor.trim().split(/\s+/));
	}
	if (template.trim()) {
		args.push('--template', ...template.trim().split(/\s+/));
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

async function runXrobotGenerateMainFromCurrent(): Promise<void> {
	await runCli({
		label: 'xrobot_gen_main',
		cmd: 'xrobot_gen_main',
		args: ['--output', 'User/xrobot_main.hpp', '--config', getWorkspaceRelativeConfig('xrobot.xrobot.configPath', 'User/xrobot.yaml')],
	});
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

function listLocalModuleCandidates(): string[] {
	const root = getWorkspaceRoot();
	if (!root) {
		return [];
	}
	const modulesDir = path.join(root, 'Modules');
	const result = new Set<string>();
	if (fs.existsSync(modulesDir)) {
		for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) {
				continue;
			}
			if (entry.name.startsWith('.')) {
				continue;
			}
			const modName = entry.name;
			const hppPath = path.join(modulesDir, modName, `${modName}.hpp`);
			const altHppPath = path.join(modulesDir, modName, `${modName}.h`);
			if (fs.existsSync(hppPath) || fs.existsSync(altHppPath) || fs.existsSync(path.join(modulesDir, modName, 'CMakeLists.txt'))) {
				result.add(modName);
			}
		}
	}
	return Array.from(result).sort((a, b) => a.localeCompare(b));
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

function ensureLibxrRootWithDeviceAliases(): Record<string, unknown> | undefined {
	const filePath = libxrConfigPath();
	const root = readYamlRoot(filePath);
	if (!root) {
		vscode.window.showErrorMessage(`Cannot load libxr config: ${filePath}`);
		return undefined;
	}
	const aliases = asRecord(root.device_aliases);
	if (!aliases) {
		vscode.window.showErrorMessage('device_aliases not found in libxr config.');
		return undefined;
	}
	root.device_aliases = aliases;
	return root;
}

function writeLibxrConfigWithValidation(root: Record<string, unknown>, operation: string): boolean {
	const filePath = libxrConfigPath();
	const result = guardedWriteYamlRoot(filePath, root, (parsedRoot) => Boolean(asRecord(parsedRoot.device_aliases)));
	if (result.ok) {
		return true;
	}
	if (result.stage === 'read') {
		vscode.window.showErrorMessage(`Cannot read libxr config before ${operation}: ${filePath}`);
		outputChannel.appendLine(`[libxr] ${operation}: read failed: ${result.error}`);
		return false;
	}
	if (result.stage === 'write') {
		vscode.window.showErrorMessage(`Failed to write libxr config during ${operation}.`);
		outputChannel.appendLine(`[libxr] ${operation}: write failed: ${result.error}`);
		return false;
	}
	vscode.window.showErrorMessage('LibXR config validation failed after alias edit; restored previous file.');
	outputChannel.appendLine(`[libxr] ${operation}: post-write validation failed: ${result.error}`);
	if (result.rollbackError) {
		outputChannel.appendLine(`[libxr] ${operation}: rollback failed: ${result.rollbackError}`);
	}
	return false;
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

export function getAtPath(root: unknown, keyPath: Array<string | number>): unknown {
	let current: unknown = root;
	for (const key of keyPath) {
		if (typeof key === 'number') {
			if (!Array.isArray(current)) {
				return undefined;
			}
			current = current[key];
		} else {
			const record = asRecord(current);
			if (!record) {
				return undefined;
			}
			current = record[key];
		}
	}
	return current;
}

export function setAtPath(root: unknown, keyPath: Array<string | number>, value: unknown): void {
	if (keyPath.length === 0) {
		return;
	}
	let current: unknown = root;
	for (let i = 0; i < keyPath.length - 1; i += 1) {
		const key = keyPath[i];
		if (typeof key === 'number') {
			if (!Array.isArray(current)) {
				return;
			}
			current = current[key];
		} else {
			const record = asRecord(current);
			if (!record) {
				return;
			}
			current = record[key];
		}
	}
	const last = keyPath[keyPath.length - 1];
	if (typeof last === 'number') {
		if (Array.isArray(current)) {
			current[last] = value;
		}
	} else {
		const record = asRecord(current);
		if (record) {
			record[last] = value;
		}
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

export async function runCli(request: CliRunRequest): Promise<void> {
	// Centralized CLI runner used by all actions and post-edit auto-generation hooks.
	const root = getWorkspaceRoot();
	if (!root) {
		vscode.window.showErrorMessage('Please open a workspace folder first.');
		return;
	}

	const args = [...(request.args ?? [])];
	if (request.promptInput) {
		const userInput = await vscode.window.showInputBox({
			prompt: request.inputPrompt ?? `Arguments for ${request.cmd}`,
			value: request.defaultInput ?? '',
		});
		if (userInput === undefined) {
			return;
		}
		if (userInput.trim()) {
			args.push(...userInput.trim().split(/\s+/));
		}
	}

	outputChannel.appendLine(`$ ${request.cmd}${args.length > 0 ? ` ${args.join(' ')}` : ''}`);
	outputChannel.appendLine(`cwd: ${root}`);
	outputChannel.appendLine('----');
	outputChannel.show(true);

	const child = spawn(request.cmd, args, {
		cwd: root,
		shell: true,
		env: getCliEnv(),
	});

	child.stdout.on('data', (data: Buffer | string) => outputChannel.append(data.toString()));
	child.stderr.on('data', (data: Buffer | string) => outputChannel.append(data.toString()));

	child.on('error', (error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') {
			void vscode.window.showErrorMessage(
				'命令未在 PATH 中，检查 pipx ensurepath 或设置 xrobot.cli.extraPath',
			);
		} else {
			void vscode.window.showErrorMessage(`Run failed: ${error.message}`);
		}
		outputChannel.appendLine(`\n[error] ${error.message}`);
	});

	child.on('close', (code: number | null) => {
		outputChannel.appendLine(`\n[exit] ${code ?? -1}`);
		outputChannel.appendLine('');
	});
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
