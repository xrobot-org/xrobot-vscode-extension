import * as vscode from 'vscode';
import { isIdentifier, valuePath, type PathSegment } from '../cli/xrobotCli';
import {
	argName,
	argValue,
	cloneTree,
	constructorSignature,
	containsNull,
	fieldAt,
	fieldShape,
	findMatchingConstructor,
	isRecord,
	matchedParameter,
	matchingShapeConstructor,
	opaqueReason,
	parameterCandidates,
	parameterShape,
	previewTree,
	seedMapping,
	switchConstructorArgs,
	treeEquals,
	type DescribeInstance,
	type DescribeModule,
	type DescribeResult,
	type ShapeField,
	type ValueShape,
	type ValueTree,
} from './describeModel';

// What the tree asks the editor to open directly; omitted => ask the user.
export type InstanceEditTarget =
	| { kind: 'id' }
	| { kind: 'template'; index: number }
	| { kind: 'arg'; name: string; path?: PathSegment[] }
	| { kind: 'constructor' };

// One CLI write: `xrobot instance set --json ID PATH JSON` or `xrobot instance rename ID NEW_ID`.
// A constructor switch is a set of PATH `args` (the whole list); `added` names the
// parameters that got their default.
export type InstanceEdit =
	| { kind: 'set'; path: string; value: ValueTree; added?: string[] }
	| { kind: 'rename'; newId: string };

type TargetPickItem = vscode.QuickPickItem & { target: InstanceEditTarget };
type ValuePickItem = vscode.QuickPickItem & {
	action: 'apply' | 'field' | 'cpp' | 'structured' | 'constructor' | 'candidate';
	key?: string | number;
};

const CPP_EXPRESSION_LABEL = '$(code) C++ expression…';

// Interactive editor driven by `xrobot describe`. Returns the single write to perform, or
// undefined when nothing must be written (cancelled, or the value did not change).
// Values the user did not enter are never written.
export async function editInstanceInteractively(
	describe: DescribeResult,
	instance: DescribeInstance,
	target?: InstanceEditTarget,
): Promise<InstanceEdit | undefined> {
	const module = describe.modules[instance.module];
	const chosen = target ?? (await pickEditTarget(module, instance));
	if (!chosen) {
		return undefined;
	}
	if (chosen.kind === 'id') {
		const newId = await promptInstanceId(describe, instance.id);
		return newId ? { kind: 'rename', newId } : undefined;
	}
	if (chosen.kind === 'template') {
		return editTemplateArg(module, instance, chosen.index);
	}
	if (chosen.kind === 'constructor') {
		return switchConstructor(module, instance);
	}
	return editArgument(describe, module, instance, chosen.name, chosen.path ?? []);
}

async function pickEditTarget(module: DescribeModule | undefined, instance: DescribeInstance): Promise<InstanceEditTarget | undefined> {
	const items: TargetPickItem[] = [{ label: `$(tag) id: ${instance.id}`, description: 'rename instance', target: { kind: 'id' } }];
	const templateParams = module?.template_parameters ?? [];
	const templateCount = Math.max(templateParams.length, instance.template_args.length);
	for (let index = 0; index < templateCount; index += 1) {
		const param = templateParams[index];
		items.push({
			label: `$(symbol-type-parameter) ${param?.name ?? `#${index}`}: ${previewTree(instance.template_args[index])}`,
			description: param ? `template ${param.type}` : 'template argument',
			target: { kind: 'template', index },
		});
	}
	for (const arg of instance.args) {
		const name = argName(arg);
		if (!name) {
			continue;
		}
		const param = matchedParameter(module, instance, name);
		items.push({
			label: `$(symbol-field) ${name}: ${previewTree(arg[name])}`,
			description: param?.type,
			target: { kind: 'arg', name },
		});
	}
	if (canSwitchConstructor(module, instance)) {
		items.push({ label: '$(list-ordered) Switch constructor…', description: 'keeps same-named values', target: { kind: 'constructor' } });
	}
	const note = module?.error ? ` (interface error: ${module.error})` : !module ? ' (Module not in the locked sources)' : '';
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: `Edit ${instance.id} (${instance.module})${note}`,
		matchOnDescription: true,
	});
	return picked?.target;
}

// Another constructor exists, or the current args match none.
export function canSwitchConstructor(module: DescribeModule | undefined, instance: DescribeInstance): boolean {
	const count = module?.constructors?.length ?? 0;
	return count > 1 || (count === 1 && findMatchingConstructor(module, instance.args) < 0);
}

type SwitchPickItem = vscode.QuickPickItem & { index?: number; apply?: boolean };

// Constructor switch (D8): pick another constructor, preview the new argument list with
// the new parameters marked, then write it as one `instance set ID args <list>`.
// Same-named values are kept; only new parameters take describe's default. Esc at any
// step writes nothing.
async function switchConstructor(module: DescribeModule | undefined, instance: DescribeInstance): Promise<InstanceEdit | undefined> {
	const ctors = module?.constructors ?? [];
	const current = findMatchingConstructor(module, instance.args);
	const choices = ctors.map((ctor, index) => ({ ctor, index })).filter(({ index }) => index !== current);
	if (!module || choices.length === 0) {
		void vscode.window.showInformationMessage(`${instance.module} has no other constructor.`);
		return undefined;
	}
	const describeSwitch = (names: string[]): string => (names.length > 0 ? names.join(', ') : 'none');
	const picked = await vscode.window.showQuickPick<SwitchPickItem>(
		choices.map(({ ctor, index }) => {
			const change = switchConstructorArgs(instance.args, ctor);
			return {
				label: `${module.class}${constructorSignature(ctor)}`,
				description: ctor.line ? `line ${ctor.line}` : undefined,
				detail: `keeps ${describeSwitch(change.kept)}; new ${describeSwitch(change.added)}; drops ${describeSwitch(change.dropped)}`,
				index,
			};
		}),
		{
			placeHolder: `Constructor for ${instance.id}${current < 0 ? ' (its args match no constructor)' : ''}`,
			matchOnDetail: true,
		},
	);
	if (picked?.index === undefined) {
		return undefined;
	}
	const ctor = ctors[picked.index];
	const change = switchConstructorArgs(instance.args, ctor);
	const items: SwitchPickItem[] = [
		{ label: '$(check) Apply', description: `write args of ${module.class}${constructorSignature(ctor)}`, apply: true },
		...change.args.map((arg): SwitchPickItem => {
			const name = argName(arg) ?? '?';
			const isNew = change.added.includes(name);
			return {
				label: `${isNew ? '$(diff-added)' : '$(circle-small)'} ${name}: ${previewTree(arg[name])}`,
				description: isNew ? (arg[name] === null ? 'NEW: no default, not filled in' : 'NEW: source default') : 'kept',
			};
		}),
		...change.dropped.map((name): SwitchPickItem => ({ label: `$(diff-removed) ${name}`, description: 'dropped' })),
	];
	for (;;) {
		const confirm = await vscode.window.showQuickPick(items, {
			placeHolder: `${instance.id}: new parameters are marked NEW; pick Apply to write, Esc to cancel`,
		});
		if (!confirm) {
			return undefined;
		}
		if (confirm.apply) {
			return { kind: 'set', path: valuePath('args', []), value: change.args, added: change.added };
		}
	}
}

async function promptInstanceId(describe: DescribeResult, currentId: string): Promise<string | undefined> {
	const taken = new Set(describe.instances.map((i) => i.id).filter((id) => id !== currentId));
	const next = await vscode.window.showInputBox({
		prompt: `Rename instance ${currentId} (xrobot instance rename also updates references in this config)`,
		value: currentId,
		validateInput: (value) => {
			const trimmed = value.trim();
			if (!isIdentifier(trimmed)) {
				return 'Instance id must be a C++ identifier';
			}
			return taken.has(trimmed) ? `Instance id ${trimmed} already exists` : undefined;
		},
	});
	const trimmed = next?.trim();
	return trimmed && trimmed !== currentId ? trimmed : undefined;
}

async function editTemplateArg(
	module: DescribeModule | undefined,
	instance: DescribeInstance,
	index: number,
): Promise<InstanceEdit | undefined> {
	if (index >= instance.template_args.length) {
		void vscode.window.showWarningMessage(
			`${instance.id} has no template argument #${index} in its config; add it to template_args in the YAML first.`,
		);
		return undefined;
	}
	const param = module?.template_parameters?.[index];
	const current = instance.template_args[index];
	const text = await promptCppText(
		`Template argument ${param?.name ?? `#${index}`} of ${instance.id}`,
		param?.type,
		current,
		'C++ type or value, e.g. Mecanum',
	);
	if (text === undefined || treeEquals(text, current)) {
		return undefined;
	}
	return { kind: 'set', path: valuePath('template_args', [index]), value: text };
}

function valueAt(root: ValueTree | undefined, segments: PathSegment[]): ValueTree | undefined {
	let node = root;
	for (const segment of segments) {
		if (typeof segment === 'number') {
			node = Array.isArray(node) ? node[segment] : undefined;
		} else {
			node = isRecord(node) ? (node as Record<string, ValueTree>)[segment] : undefined;
		}
	}
	return node;
}

function segmentLabel(name: string, segments: PathSegment[]): string {
	return segments.reduce<string>((text, s) => (typeof s === 'number' ? `${text}[${s}]` : `${text}.${s}`), name);
}

// Edit the value at args.<name><segments>. Mappings and lists are navigated down to the
// value to change, so each edit writes one node.
async function editArgument(
	describe: DescribeResult,
	module: DescribeModule | undefined,
	instance: DescribeInstance,
	name: string,
	segments: PathSegment[],
): Promise<InstanceEdit | undefined> {
	const root = argValue(instance.args, name);
	if (root === undefined) {
		void vscode.window.showWarningMessage(`${instance.id} has no argument ${name}.`);
		return undefined;
	}
	if (segments.length > 0 && valueAt(root, segments) === undefined) {
		void vscode.window.showWarningMessage(`${segmentLabel(name, segments)} is no longer in ${instance.id}.`);
		return undefined;
	}
	const param = matchedParameter(module, instance, name);
	// Esc goes back up to the level the edit started at, then cancels.
	const startDepth = segments.length;
	for (;;) {
		const current = valueAt(root, segments);
		const label = segmentLabel(name, segments);
		const field: ShapeField | undefined =
			segments.length === 0
				? param && { name, type: param.type, typeRef: param.type_ref }
				: fieldAt(param, segments, root, describe.types);
		const shape = segments.length === 0 ? param && parameterShape(param, describe.types) : field && fieldShape(field, describe.types);

		if (Array.isArray(current) || isRecord(current)) {
			const entries: Array<[PathSegment, ValueTree]> = Array.isArray(current)
				? current.map((v, i) => [i, v])
				: Object.entries(current as Record<string, ValueTree>);
			const items: ValuePickItem[] = entries.map(([key, v]) => ({
				label: typeof key === 'number' ? `[${key}]` : key,
				description: previewTree(v),
				action: 'field',
				key,
			}));
			items.push({ label: CPP_EXPRESSION_LABEL, description: `replace ${label} with C++ text`, action: 'cpp' });
			if (shape) {
				items.push({ label: '$(symbol-structure) Rebuild from the type…', description: shape.kind === 'constructors' ? 'choose a constructor' : 'all fields', action: 'structured' });
			}
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: `${label}${field?.type ? ` (${field.type})` : ''}: pick the value to edit`,
				matchOnDescription: true,
			});
			if (!picked) {
				if (segments.length <= startDepth) {
					return undefined;
				}
				segments = segments.slice(0, -1);
				continue;
			}
			if (picked.action === 'field' && picked.key !== undefined) {
				const key = picked.key;
				if (typeof key === 'string' && !isIdentifier(key)) {
					void vscode.window.showWarningMessage(`Key "${key}" cannot be addressed by xrobot instance set; edit the YAML directly.`);
					continue;
				}
				segments = [...segments, key];
				continue;
			}
			const next = picked.action === 'cpp'
				? await promptCppText(label, field?.type, undefined)
				: shape && (await buildShapedValue(describe, label, shape, current));
			if (next === undefined) {
				continue;
			}
			return setEdit(name, segments, current, next);
		}

		const candidates = segments.length === 0 ? parameterCandidates(instance, name, param) : [];
		// describe explains why a type has no field editor (e.g. virtual functions).
		const opaque = opaqueReason(field?.typeRef, describe.types);
		const typeText = opaque ? `${field?.type}; C++ text only: ${opaque}` : field?.type;
		const next = await pickScalarValue(describe, label, typeText, current, candidates, shape);
		if (next === undefined) {
			if (segments.length <= startDepth) {
				return undefined;
			}
			segments = segments.slice(0, -1);
			continue;
		}
		return setEdit(name, segments, current, next);
	}
}

function setEdit(name: string, segments: PathSegment[], current: ValueTree | undefined, next: ValueTree): InstanceEdit | undefined {
	if (treeEquals(current, next)) {
		return undefined;
	}
	return { kind: 'set', path: valuePath('args', [name, ...segments]), value: next };
}

async function pickScalarValue(
	describe: DescribeResult,
	label: string,
	type: string | undefined,
	current: ValueTree | undefined,
	candidates: string[],
	shape: ValueShape | undefined,
): Promise<ValueTree | undefined> {
	if (candidates.length === 0 && !shape) {
		return promptCppText(label, type, current);
	}
	for (;;) {
		const items: ValuePickItem[] = candidates.map((candidate) => ({
			label: candidate,
			description: candidate === current ? 'current' : undefined,
			action: 'candidate',
		}));
		items.push({ label: CPP_EXPRESSION_LABEL, action: 'cpp' });
		if (shape) {
			items.push({ label: '$(symbol-structure) Structured value…', description: shape.typeName, action: 'structured' });
		}
		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: `${label}${type ? ` (${type})` : ''}: current ${previewTree(current)}`,
		});
		if (!picked) {
			return undefined;
		}
		if (picked.action === 'candidate') {
			return picked.label;
		}
		const next = picked.action === 'cpp' ? await promptCppText(label, type, current) : shape && (await buildShapedValue(describe, label, shape, current));
		if (next !== undefined) {
			return next;
		}
	}
}

// C++ text input. Esc returns undefined; an empty value cannot be submitted.
async function promptCppText(
	label: string,
	type: string | undefined,
	current: ValueTree | undefined,
	placeHolder = 'C++ expression',
): Promise<string | undefined> {
	const input = await vscode.window.showInputBox({
		prompt: `${label}${type ? ` (${type})` : ''}: C++ expression (Esc cancels, nothing is written)`,
		value: typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean' ? String(current) : '',
		placeHolder,
		validateInput: (value) => (value.trim() ? undefined : 'Enter a C++ expression, or press Esc to cancel'),
	});
	return input === undefined ? undefined : input.trim();
}

// Build a complete mapping for a shaped value (aggregate fields, or one class
// constructor's parameters), seeded from the current value and the source defaults.
// Fields without a default start as `{}` (value-initialized), as `xrobot instance add`
// seeds them; constructor parameters without a default must be filled before Apply.
async function buildShapedValue(
	describe: DescribeResult,
	label: string,
	shape: ValueShape,
	current: ValueTree | undefined,
): Promise<ValueTree | undefined> {
	let fields: ShapeField[];
	if (shape.kind === 'constructors') {
		const matched = matchingShapeConstructor(shape.constructors, current);
		const picked = await vscode.window.showQuickPick(
			shape.constructors.map((ctor, index) => ({
				label: `${shape.typeName}(${ctor.map((f) => `${f.type ?? ''} ${f.name}`.trim()).join(', ')})`,
				description: index === matched ? 'current' : undefined,
				index,
			})),
			{ placeHolder: `${label}: pick the ${shape.typeName} constructor` },
		);
		if (!picked) {
			return undefined;
		}
		fields = shape.constructors[picked.index];
	} else {
		fields = shape.fields.map((f) =>
			f.defaultTree === undefined && (f.defaultText === null || f.defaultText === undefined) ? { ...f, defaultText: '{}' } : f,
		);
	}
	const value = seedMapping(fields, current);
	for (;;) {
		const unfilled = fields.filter((f) => containsNull(value[f.name] ?? null)).map((f) => f.name);
		const items: ValuePickItem[] = [
			{
				label: '$(check) Apply',
				description: unfilled.length > 0 ? `fill ${unfilled.join(', ')} first` : `write ${label}`,
				action: 'apply',
			},
			...fields.map((field) => ({
				label: field.name,
				description: previewTree(value[field.name]),
				detail: field.type,
				action: 'field' as const,
				key: field.name,
			})),
		];
		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: `${label}${shape.typeName ? ` (${shape.typeName})` : ''}: edit fields, then Apply (Esc cancels, nothing is written)`,
			matchOnDescription: true,
		});
		if (!picked) {
			return undefined;
		}
		if (picked.action === 'apply') {
			if (unfilled.length > 0) {
				void vscode.window.showWarningMessage(`Fill ${unfilled.join(', ')} before applying ${label}.`);
				continue;
			}
			return value;
		}
		const field = fields.find((f) => f.name === picked.key);
		if (!field) {
			continue;
		}
		const nested = fieldShape(field, describe.types);
		const fieldLabel = `${label}.${field.name}`;
		const next = nested
			? await pickScalarValue(describe, fieldLabel, field.type, value[field.name], [], nested)
			: await promptCppText(fieldLabel, field.type, value[field.name]);
		if (next !== undefined) {
			value[field.name] = cloneTree(next);
		}
	}
}
