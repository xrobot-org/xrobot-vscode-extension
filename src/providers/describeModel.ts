// Pure model of `xrobot describe` output (schema 1, XRobot 1.0) plus value helpers used
// by the XRobot view and the instance editor. Nothing here parses C++ or manifests:
// every interface fact comes from `xrobot describe`. No `vscode` import (unit-tested).

export const DESCRIBE_SCHEMA = 1;

// A configuration value: C++ expression text, `null` (not filled in yet), or a YAML
// list/mapping for structured initializers.
export type ValueTree = string | number | boolean | null | ValueTree[] | { [key: string]: ValueTree };

export type NamedValue = Record<string, ValueTree>;

export type DescribeHeader = {
	path: string;
	status: 'fresh' | 'stale' | 'missing' | 'unreadable' | string;
	config: string | null;
	newer: string[];
	missing: string[];
};

export type DescribeLockModule = {
	id: string;
	commit: string | null;
	head: string | null;
	status: 'ok' | 'missing' | 'mismatch' | 'broken' | string;
};

export type DescribeLock = {
	path: string;
	present: boolean;
	status: 'ok' | 'absent' | string;
	modules: DescribeLockModule[];
};

export type DescribeParameter = {
	name: string;
	type: string;
	default: string | null;
	dependency: boolean;
	default_fields: Record<string, ValueTree> | null;
	type_ref: string | null;
	candidates: string[];
};

export type DescribeConstructor = {
	line: number | null;
	parameters: DescribeParameter[];
};

export type DescribeTemplateParameter = {
	name: string;
	type: string;
	default: string | null;
};

export type DescribeModule = {
	id: string;
	class: string;
	header?: string;
	standalone?: boolean;
	template_parameters?: DescribeTemplateParameter[];
	constructors?: DescribeConstructor[];
	error?: string;
};

export type DescribeTypeMember = {
	name: string;
	type: string;
	type_ref: string | null;
	default?: string | null;
};

export type DescribeType =
	| { kind: 'aggregate'; fields: DescribeTypeMember[] }
	| { kind: 'class'; constructors: DescribeTypeMember[][] }
	| { kind: 'opaque'; reason: string };

export type DescribeInstance = {
	id: string;
	module: string;
	class: string | null;
	template_args: ValueTree[];
	args: NamedValue[];
	// Per parameter name: registered names, earlier instance ids and constexprs that bind.
	candidates: Record<string, string[]>;
};

export type DescribeConstexpr = { name: string; qualified: string; type: string };

export type DescribeDiagnostic = {
	severity: 'error' | 'warning' | string;
	scope: string;
	message: string;
};

export type DescribeResult = {
	schema: number;
	root: string;
	configs: string[];
	config: string;
	selected: string;
	header: DescribeHeader;
	tools: { xrobot: { installed: string; pin: string | null } };
	lock: DescribeLock;
	entry: string | null;
	registrations: Array<{ name: string; type: string }>;
	modules: Record<string, DescribeModule>;
	types: Record<string, DescribeType | null>;
	instances: DescribeInstance[];
	constexprs: DescribeConstexpr[];
	diagnostics: DescribeDiagnostic[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

export function parseDescribeOutput(stdout: string): { ok: true; value: DescribeResult } | { ok: false; error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		return { ok: false, error: `xrobot describe printed invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!isRecord(parsed)) {
		return { ok: false, error: 'xrobot describe did not print a JSON object' };
	}
	if (parsed.schema !== DESCRIBE_SCHEMA) {
		return { ok: false, error: `unsupported xrobot describe schema ${String(parsed.schema)} (this extension reads schema ${DESCRIBE_SCHEMA})` };
	}
	if (typeof parsed.config !== 'string' || !isRecord(parsed.header) || !isRecord(parsed.lock)) {
		return { ok: false, error: 'xrobot describe output lacks config/header/lock' };
	}
	const value = parsed as DescribeResult;
	value.configs = asArray<string>(value.configs);
	value.selected = typeof value.selected === 'string' ? value.selected : value.config;
	value.header.newer = asArray<string>(value.header.newer);
	value.header.missing = asArray<string>(value.header.missing);
	value.tools = isRecord(value.tools) && isRecord(value.tools.xrobot) ? value.tools : { xrobot: { installed: '?', pin: null } };
	value.lock.modules = asArray<DescribeLockModule>(value.lock.modules);
	value.registrations = asArray(value.registrations);
	value.modules = isRecord(value.modules) ? value.modules : {};
	value.types = isRecord(value.types) ? value.types : {};
	value.instances = asArray<DescribeInstance>(value.instances);
	value.constexprs = asArray<DescribeConstexpr>(value.constexprs);
	value.diagnostics = asArray<DescribeDiagnostic>(value.diagnostics);
	for (const instance of value.instances) {
		instance.template_args = asArray<ValueTree>(instance.template_args);
		instance.args = asArray<NamedValue>(instance.args);
		instance.candidates = isRecord(instance.candidates) ? instance.candidates : {};
	}
	return { ok: true, value };
}

// ---------------------------------------------------------------------------------------
// Instances: args are an ordered list of single-key mappings {param_name: value}.

export function argName(arg: NamedValue): string | undefined {
	const keys = Object.keys(arg ?? {});
	return keys.length === 1 ? keys[0] : undefined;
}

export function argValue(args: NamedValue[], name: string): ValueTree | undefined {
	const entry = args.find((arg) => argName(arg) === name);
	return entry ? entry[name] : undefined;
}

export function constructorSignature(ctor: DescribeConstructor): string {
	return `(${ctor.parameters.map((p) => `${p.type} ${p.name}`).join(', ')})`;
}

// The constructor whose parameter names equal the instance's arg names, in order
// (the rule the generator applies); -1 when none matches.
export function findMatchingConstructor(module: DescribeModule | undefined, args: NamedValue[]): number {
	const names = args.map((arg) => argName(arg) ?? '\u0001').join('\u0000');
	return (module?.constructors ?? []).findIndex((ctor) => ctor.parameters.map((p) => p.name).join('\u0000') === names);
}

export function matchedParameter(
	module: DescribeModule | undefined,
	instance: DescribeInstance,
	name: string,
): DescribeParameter | undefined {
	const index = findMatchingConstructor(module, instance.args);
	return index >= 0 ? module?.constructors?.[index].parameters.find((p) => p.name === name) : undefined;
}

// Names that bind to a parameter of this instance: describe's per-instance list
// (registrations, earlier instances, constexprs), else the module-level registrations.
export function parameterCandidates(instance: DescribeInstance, name: string, param: DescribeParameter | undefined): string[] {
	const perInstance = instance.candidates[name];
	return Array.isArray(perInstance) ? perInstance : param?.candidates ?? [];
}

export function diagnosticsFor(result: DescribeResult, scope: string): DescribeDiagnostic[] {
	return result.diagnostics.filter((d) => d.scope === scope);
}

export function errorCount(result: DescribeResult): number {
	return result.diagnostics.filter((d) => d.severity === 'error').length;
}

// The tool regenerates the header for the selected product; the extension only asks for
// it when describe reports no error (so `xrobot gen` is expected to succeed) and the
// header is not fresh.
export function shouldRegenerate(result: DescribeResult): boolean {
	return result.config === result.selected && errorCount(result) === 0 && result.header.status !== 'fresh';
}

// ---------------------------------------------------------------------------------------
// Mapping shapes: which keys a YAML mapping for a value must use (generator rule:
// designated default fields, else aggregate fields in order, else one constructor's
// parameter names in order). Opaque types have no mapping shape.

export type ShapeField = {
	name: string;
	type?: string;
	typeRef?: string | null;
	// Designated default subtree for this field (fixes nested mapping keys).
	defaultTree?: ValueTree;
	// Default text (aggregate member initializer or constructor default).
	defaultText?: string | null;
};

export type ValueShape =
	| { kind: 'fields'; typeName?: string; fields: ShapeField[] }
	| { kind: 'constructors'; typeName: string; constructors: ShapeField[][] };

function memberFields(members: DescribeTypeMember[]): ShapeField[] {
	return members.map((m) => ({ name: m.name, type: m.type, typeRef: m.type_ref, defaultText: m.default ?? null }));
}

export function typeShape(typeRef: string | null | undefined, types: DescribeResult['types']): ValueShape | undefined {
	const entry = typeRef ? types[typeRef] : undefined;
	if (!entry) {
		return undefined;
	}
	if (entry.kind === 'aggregate') {
		return { kind: 'fields', typeName: typeRef ?? undefined, fields: memberFields(entry.fields ?? []) };
	}
	if (entry.kind === 'class') {
		const ctors = (entry.constructors ?? []).filter((c) => c.length > 0).map(memberFields);
		return ctors.length > 0 && typeRef ? { kind: 'constructors', typeName: typeRef, constructors: ctors } : undefined;
	}
	return undefined;
}

export function opaqueReason(typeRef: string | null | undefined, types: DescribeResult['types']): string | undefined {
	const entry = typeRef ? types[typeRef] : undefined;
	return entry?.kind === 'opaque' ? entry.reason : undefined;
}

export function shapeFromDefaultTree(
	tree: Record<string, ValueTree>,
	typeRef: string | null | undefined,
	types: DescribeResult['types'],
): ValueShape {
	const byType = typeShape(typeRef, types);
	const typed = byType?.kind === 'fields' ? byType.fields : [];
	return {
		kind: 'fields',
		typeName: typeRef ?? undefined,
		fields: Object.entries(tree).map(([name, defaultTree]) => {
			const member = typed.find((f) => f.name === name);
			return { name, type: member?.type, typeRef: member?.typeRef ?? null, defaultTree };
		}),
	};
}

export function parameterShape(param: DescribeParameter, types: DescribeResult['types']): ValueShape | undefined {
	if (isRecord(param.default_fields)) {
		return shapeFromDefaultTree(param.default_fields as Record<string, ValueTree>, param.type_ref, types);
	}
	return typeShape(param.type_ref, types);
}

export function fieldShape(field: ShapeField, types: DescribeResult['types']): ValueShape | undefined {
	if (isRecord(field.defaultTree)) {
		return shapeFromDefaultTree(field.defaultTree as Record<string, ValueTree>, field.typeRef, types);
	}
	return typeShape(field.typeRef, types);
}

// Type information for a value inside a parameter (`segments` are mapping keys / list
// indexes below the parameter), following the shape as far as it is known.
export function fieldAt(
	param: DescribeParameter | undefined,
	segments: Array<string | number>,
	current: ValueTree | undefined,
	types: DescribeResult['types'],
): ShapeField | undefined {
	if (!param) {
		return undefined;
	}
	let field: ShapeField = { name: param.name, type: param.type, typeRef: param.type_ref };
	let shape = parameterShape(param, types);
	for (const segment of segments) {
		if (typeof segment === 'number' || !shape) {
			return undefined;
		}
		const fields =
			shape.kind === 'fields'
				? shape.fields
				: shape.constructors[matchingShapeConstructor(shape.constructors, current)] ?? undefined;
		const next = fields?.find((f) => f.name === segment);
		if (!next) {
			return undefined;
		}
		field = next;
		current = isRecord(current) ? (current as Record<string, ValueTree>)[segment] : undefined;
		shape = fieldShape(next, types);
	}
	return field;
}

// Mapping keyed exactly by `fields` (in order), keeping current values where the key
// exists; a positional list of the same length is zipped onto the field names.
export function seedMapping(fields: ShapeField[], current: ValueTree | undefined): Record<string, ValueTree> {
	const result: Record<string, ValueTree> = {};
	const currentRecord = isRecord(current) ? (current as Record<string, ValueTree>) : undefined;
	const currentList = Array.isArray(current) && current.length === fields.length ? current : undefined;
	fields.forEach((field, index) => {
		if (currentRecord && Object.prototype.hasOwnProperty.call(currentRecord, field.name)) {
			result[field.name] = cloneTree(currentRecord[field.name]);
		} else if (currentList) {
			result[field.name] = cloneTree(currentList[index]);
		} else if (field.defaultTree !== undefined) {
			result[field.name] = cloneTree(field.defaultTree);
		} else {
			result[field.name] = field.defaultText ?? null;
		}
	});
	return result;
}

// Index of the class constructor whose parameter names match a current mapping's keys.
export function matchingShapeConstructor(ctors: ShapeField[][], current: ValueTree | undefined): number {
	if (!isRecord(current)) {
		return -1;
	}
	const keys = Object.keys(current).join('\u0000');
	return ctors.findIndex((ctor) => ctor.map((f) => f.name).join('\u0000') === keys);
}

export function cloneTree(value: ValueTree): ValueTree {
	return value === null || typeof value !== 'object' ? value : (JSON.parse(JSON.stringify(value)) as ValueTree);
}

export function treeEquals(a: ValueTree | undefined, b: ValueTree | undefined): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

// Values a structured edit produced still contain nulls for fields without a default:
// they are written as `null` ("not filled in"), which the generator rejects until filled.
export function containsNull(value: ValueTree): boolean {
	if (value === null) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.some(containsNull);
	}
	if (typeof value === 'object') {
		return Object.values(value).some(containsNull);
	}
	return false;
}

export function previewTree(value: ValueTree | undefined, max = 60): string {
	const text = compactTree(value);
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function compactTree(value: ValueTree | undefined): string {
	if (value === undefined) {
		return '(unset)';
	}
	if (value === null) {
		return 'null (not filled in)';
	}
	if (Array.isArray(value)) {
		return `[${value.map((v) => (v === null ? 'null' : compactTree(v))).join(', ')}]`;
	}
	if (typeof value === 'object') {
		return `{${Object.entries(value)
			.map(([k, v]) => `${k}: ${v === null ? 'null' : compactTree(v)}`)
			.join(', ')}}`;
	}
	return String(value);
}

export function shortCommit(sha: string | null | undefined): string {
	return sha ? sha.slice(0, 8) : '-';
}

export function describeSummary(result: DescribeResult): string {
	const errors = errorCount(result);
	const warnings = result.diagnostics.length - errors;
	return `header ${result.header.status} | lock ${result.lock.status} | ${errors} errors, ${warnings} warnings`;
}
