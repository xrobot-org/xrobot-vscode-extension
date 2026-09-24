import * as vscode from 'vscode';
import {
	argName,
	argValue,
	cloneTree,
	constructorSignature,
	defaultArgsForConstructor,
	fieldShape,
	findMatchingConstructor,
	isCppIdentifier,
	isRecord,
	matchingShapeConstructor,
	parameterShape,
	previewTree,
	seedMapping,
	withArgValue,
	withTemplateArg,
	type DescribeConstructor,
	type DescribeInstance,
	type DescribeModule,
	type DescribeParameter,
	type DescribeResult,
	type InstanceSetValues,
	type NamedValue,
	type ShapeField,
	type ValueShape,
	type ValueTree,
} from './describeModel';

// What the tree asks the editor to open directly; omitted => ask the user.
export type InstanceEditTarget =
	| { kind: 'id' }
	| { kind: 'arg'; name: string }
	| { kind: 'template'; index: number }
	| { kind: 'constructor' };

type TargetPickItem = vscode.QuickPickItem & { target?: InstanceEditTarget };
type ValuePickItem = vscode.QuickPickItem & { action: 'apply' | 'field' | 'cpp' | 'constructor' | 'candidate'; key?: string | number };

const CPP_EXPRESSION_LABEL = '$(code) C++ expression…';

// Interactive argument editor driven by xrobot_describe. Returns the values to pass to
// `xrobot_instance set`, or undefined when nothing should be written.
export async function editInstanceInteractively(
	describe: DescribeResult,
	instance: DescribeInstance,
	target?: InstanceEditTarget,
): Promise<InstanceSetValues | undefined> {
	const module = describe.modules[instance.module];
	let args: NamedValue[] = instance.args.map((arg) => ({ ...arg }));
	let argsReset = false;
	const ctors = module?.constructors ?? [];
	let ctorIndex = findMatchingConstructor(module, args);

	const resetToConstructor = async (placeHolder: string): Promise<boolean> => {
		const picked = await pickConstructor(ctors, placeHolder);
		if (picked === undefined) {
			return false;
		}
		ctorIndex = picked;
		args = defaultArgsForConstructor(ctors[picked]);
		argsReset = true;
		return true;
	};

	if (target?.kind === 'id') {
		const nextId = await promptInstanceId(describe, instance.id);
		return nextId ? { id: nextId } : undefined;
	}
	if (target?.kind === 'template') {
		const template = await editTemplateArg(module, instance, target.index);
		return template ? { template_args: template } : undefined;
	}
	if (target?.kind === 'constructor') {
		if (ctors.length === 0 || !(await resetToConstructor('Pick the constructor; args reset to its parameters and defaults'))) {
			return undefined;
		}
	} else if (ctors.length > 0 && ctorIndex < 0) {
		const placeHolder = `No constructor of ${module?.class ?? instance.module} matches args (${args
			.map((a) => argName(a) ?? '?')
			.join(', ')}); pick one to reset args to its defaults`;
		if (!(await resetToConstructor(placeHolder))) {
			return undefined;
		}
	}

	let paramName = target?.kind === 'arg' ? target.name : undefined;
	if (paramName && argsReset && argValue(args, paramName) === undefined) {
		// The chosen constructor has no parameter of that name: let the user pick one.
		paramName = undefined;
	}
	if (!paramName) {
		const picked = await pickEditTarget(module, instance, args, ctorIndex, argsReset);
		if (!picked) {
			return argsReset ? { args } : undefined;
		}
		if (picked.kind === 'id') {
			const nextId = await promptInstanceId(describe, instance.id);
			if (!nextId) {
				return argsReset ? { args } : undefined;
			}
			return argsReset ? { id: nextId, args } : { id: nextId };
		}
		if (picked.kind === 'template') {
			const template = await editTemplateArg(module, instance, picked.index);
			if (!template) {
				return argsReset ? { args } : undefined;
			}
			return argsReset ? { template_args: template, args } : { template_args: template };
		}
		if (picked.kind === 'constructor') {
			if (!(await resetToConstructor('Pick the constructor; args reset to its parameters and defaults'))) {
				return undefined;
			}
			return { args };
		}
		paramName = picked.name;
	}

	const param = ctorIndex >= 0 ? ctors[ctorIndex].parameters.find((p) => p.name === paramName) : undefined;
	const current = argValue(args, paramName);
	const next = await editParameterValue(describe, paramName, param, current);
	if (next === undefined) {
		return argsReset ? { args } : undefined;
	}
	return { args: withArgValue(args, paramName, next) };
}

async function pickEditTarget(
	module: DescribeModule | undefined,
	instance: DescribeInstance,
	args: NamedValue[],
	ctorIndex: number,
	argsReset: boolean,
): Promise<InstanceEditTarget | undefined> {
	const ctor = ctorIndex >= 0 ? module?.constructors?.[ctorIndex] : undefined;
	const items: TargetPickItem[] = [
		{ label: `$(tag) id: ${instance.id}`, description: 'rename instance', target: { kind: 'id' } },
	];
	(module?.template_parameters ?? []).forEach((param, index) => {
		items.push({
			label: `$(symbol-type-parameter) ${param.name}: ${previewTree(instance.template_args[index] ?? param.default ?? null)}`,
			description: `template ${param.type}`,
			target: { kind: 'template', index },
		});
	});
	const names = ctor ? ctor.parameters.map((p) => p.name) : args.map((a) => argName(a)).filter((n): n is string => !!n);
	for (const name of names) {
		const param = ctor?.parameters.find((p) => p.name === name);
		items.push({
			label: `$(symbol-field) ${name}: ${previewTree(argValue(args, name))}`,
			description: param?.type,
			target: { kind: 'arg', name },
		});
	}
	if ((module?.constructors?.length ?? 0) > 1) {
		items.push({ label: '$(list-ordered) Switch constructor…', description: 'resets args to defaults', target: { kind: 'constructor' } });
	}
	const moduleNote = module?.error ? ` (interface error: ${module.error})` : !module ? ' (module not in locked sources)' : '';
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: argsReset
			? `Args of ${instance.id} reset to constructor defaults; pick a parameter to edit, or Esc to save the reset`
			: `Edit ${instance.id} (${instance.module})${moduleNote}`,
		matchOnDescription: true,
	});
	return picked?.target;
}

async function pickConstructor(ctors: DescribeConstructor[], placeHolder: string): Promise<number | undefined> {
	if (ctors.length === 1) {
		const ok = await vscode.window.showQuickPick([{ label: constructorSignature(ctors[0]), index: 0 }], { placeHolder });
		return ok?.index;
	}
	const picked = await vscode.window.showQuickPick(
		ctors.map((ctor, index) => ({
			label: constructorSignature(ctor),
			description: ctor.line ? `line ${ctor.line}` : undefined,
			index,
		})),
		{ placeHolder },
	);
	return picked?.index;
}

async function promptInstanceId(describe: DescribeResult, currentId: string): Promise<string | undefined> {
	const taken = new Set(describe.instances.map((i) => i.id).filter((id) => id !== currentId));
	const next = await vscode.window.showInputBox({
		prompt: `Rename instance ${currentId} (references to the old id in other instances are not rewritten)`,
		value: currentId,
		validateInput: (value) => {
			const trimmed = value.trim();
			if (!isCppIdentifier(trimmed)) {
				return 'Instance id must be a C++ identifier';
			}
			if (taken.has(trimmed)) {
				return `Instance id ${trimmed} already exists`;
			}
			return undefined;
		},
	});
	if (!next || next.trim() === currentId) {
		return undefined;
	}
	return next.trim();
}

async function editTemplateArg(
	module: DescribeModule | undefined,
	instance: DescribeInstance,
	index: number,
): Promise<ValueTree[] | undefined> {
	const params = module?.template_parameters ?? [];
	const param = params[index];
	const current = instance.template_args[index] ?? param?.default ?? null;
	const input = await vscode.window.showInputBox({
		prompt: `Template argument ${param?.name ?? `#${index}`}${param ? ` (${param.type})` : ''} of ${instance.id}`,
		value: current === null || typeof current === 'object' ? '' : String(current),
		placeHolder: 'C++ type or value, e.g. Mecanum',
	});
	if (input === undefined || !input.trim()) {
		return undefined;
	}
	return withTemplateArg(instance.template_args, params, index, input.trim());
}

// Edit one constructor parameter. Candidates first, then structured editing when the
// generator accepts a mapping for it, else plain C++ text.
export async function editParameterValue(
	describe: DescribeResult,
	name: string,
	param: DescribeParameter | undefined,
	current: ValueTree | undefined,
): Promise<ValueTree | undefined> {
	const shape = param ? parameterShape(param, describe.types) : undefined;
	const candidates = param?.candidates ?? [];
	if (candidates.length > 0) {
		const items: ValuePickItem[] = candidates.map((candidate) => ({
			label: candidate,
			description: candidate === current ? 'current' : undefined,
			action: 'candidate',
		}));
		items.push({ label: CPP_EXPRESSION_LABEL, action: 'cpp' });
		if (shape) {
			items.push({ label: '$(symbol-structure) Structured value…', action: 'field' });
		}
		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: `${name}${param ? ` (${param.type})` : ''}: pick a registered name / instance id`,
		});
		if (!picked) {
			return undefined;
		}
		if (picked.action === 'candidate') {
			return picked.label;
		}
		if (picked.action === 'cpp') {
			return promptCppText(name, param?.type, current);
		}
	}
	if (shape) {
		return editShapedValue(describe, name, shape, current, true);
	}
	return promptCppText(name, param?.type, current);
}

async function promptCppText(label: string, type: string | undefined, current: ValueTree | undefined): Promise<ValueTree | undefined> {
	const input = await vscode.window.showInputBox({
		prompt: `${label}${type ? ` (${type})` : ''}: C++ expression; leave empty for null (not filled in)`,
		value: typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean' ? String(current) : '',
	});
	if (input === undefined) {
		return undefined;
	}
	return input.trim() ? input.trim() : null;
}

// Mapping editor: aggregates walk their fields, classes first pick a constructor.
// The produced mapping always lists exactly the shape's keys in declaration order.
async function editShapedValue(
	describe: DescribeResult,
	label: string,
	shape: ValueShape,
	current: ValueTree | undefined,
	topLevel: boolean,
): Promise<ValueTree | undefined> {
	let fields: ShapeField[];
	if (shape.kind === 'constructors') {
		const matched = matchingShapeConstructor(shape.constructors, current);
		const picked = matched >= 0 && shape.constructors.length === 1
			? matched
			: await pickShapeConstructor(shape, matched, label);
		if (picked === undefined) {
			return undefined;
		}
		if (picked === 'cpp') {
			return promptCppText(label, shape.typeName, current);
		}
		fields = shape.constructors[picked];
	} else {
		fields = shape.fields;
	}
	const value = seedMapping(fields, current);
	// C++ text cannot be split into fields; the mapping then starts from the defaults.
	const note = typeof current === 'string' && current.trim() ? ' (was C++ text; fields start from defaults)' : '';

	for (;;) {
		const items: ValuePickItem[] = [
			{ label: topLevel ? '$(check) Apply' : '$(check) Done', description: `${label} with ${fields.length} fields`, action: 'apply' },
			...fields.map((field) => ({
				label: field.name,
				description: previewTree(value[field.name]),
				detail: field.type,
				action: 'field' as const,
				key: field.name,
			})),
			{ label: CPP_EXPRESSION_LABEL, description: 'replace the mapping with C++ text', action: 'cpp' },
		];
		if (shape.kind === 'constructors' && shape.constructors.length > 1) {
			items.push({ label: '$(list-ordered) Choose another constructor…', action: 'constructor' });
		}
		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: `${label}${shape.typeName ? ` (${shape.typeName})` : ''}: pick a field to edit${note}`,
			matchOnDescription: true,
		});
		if (!picked) {
			return undefined;
		}
		if (picked.action === 'apply') {
			return value;
		}
		if (picked.action === 'cpp') {
			const text = await promptCppText(label, shape.typeName, current);
			if (text !== undefined) {
				return text;
			}
			continue;
		}
		if (picked.action === 'constructor') {
			return editShapedValue(describe, label, shape, undefined, topLevel);
		}
		const field = fields.find((f) => f.name === picked.key);
		if (!field) {
			continue;
		}
		const next = await editFieldValue(describe, `${label}.${field.name}`, field, value[field.name]);
		if (next !== undefined) {
			value[field.name] = next;
		}
	}
}

async function pickShapeConstructor(
	shape: Extract<ValueShape, { kind: 'constructors' }>,
	matched: number,
	label: string,
): Promise<number | 'cpp' | undefined> {
	const items: Array<vscode.QuickPickItem & { index: number | 'cpp' }> = shape.constructors.map((ctor, index) => ({
		label: `${shape.typeName}(${ctor.map((f) => `${f.type ?? ''} ${f.name}`.trim()).join(', ')})`,
		description: index === matched ? 'current' : undefined,
		index,
	}));
	items.push({ label: CPP_EXPRESSION_LABEL, index: 'cpp' });
	const picked = await vscode.window.showQuickPick(items, { placeHolder: `${label}: pick the ${shape.typeName} constructor` });
	return picked?.index;
}

async function editFieldValue(
	describe: DescribeResult,
	label: string,
	field: ShapeField,
	current: ValueTree,
): Promise<ValueTree | undefined> {
	const shape = fieldShape(field, describe.types);
	if (shape) {
		return editShapedValue(describe, label, shape, current, false);
	}
	if (Array.isArray(current) || isRecord(current)) {
		return editFreeTree(label, field.type, current);
	}
	return promptCppText(label, field.type, current);
}

// Lists and mappings without a known shape: keep their keys/length, edit elements.
async function editFreeTree(label: string, type: string | undefined, current: ValueTree[] | Record<string, ValueTree>): Promise<ValueTree | undefined> {
	const value = cloneTree(current) as ValueTree[] | Record<string, ValueTree>;
	for (;;) {
		const entries: Array<[string | number, ValueTree]> = Array.isArray(value)
			? value.map((v, i) => [i, v])
			: Object.entries(value);
		const items: ValuePickItem[] = [
			{ label: '$(check) Done', description: label, action: 'apply' },
			...entries.map(([key, v]) => ({
				label: typeof key === 'number' ? `[${key}]` : key,
				description: previewTree(v),
				action: 'field' as const,
				key,
			})),
			{ label: CPP_EXPRESSION_LABEL, description: 'replace with C++ text', action: 'cpp' },
		];
		const picked = await vscode.window.showQuickPick(items, { placeHolder: `${label}${type ? ` (${type})` : ''}: pick an element to edit` });
		if (!picked) {
			return undefined;
		}
		if (picked.action === 'apply') {
			return value;
		}
		if (picked.action === 'cpp') {
			const text = await promptCppText(label, type, undefined);
			if (text !== undefined) {
				return text;
			}
			continue;
		}
		const key = picked.key;
		if (key === undefined) {
			continue;
		}
		const element = Array.isArray(value) ? value[key as number] : value[key as string];
		const childLabel = typeof key === 'number' ? `${label}[${key}]` : `${label}.${key}`;
		const next = Array.isArray(element) || isRecord(element)
			? await editFreeTree(childLabel, undefined, element as ValueTree[] | Record<string, ValueTree>)
			: await promptCppText(childLabel, undefined, element);
		if (next === undefined) {
			continue;
		}
		if (Array.isArray(value)) {
			value[key as number] = next;
		} else {
			value[key as string] = next;
		}
	}
}
