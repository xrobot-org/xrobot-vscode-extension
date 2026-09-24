// Pure model of `xrobot_describe` output (schema 1) plus the CLI argument builders
// and value helpers used by the XRobot view and the instance argument editor.
// Nothing here parses C++ or YAML: every interface fact comes from xrobot_describe.

export const DESCRIBE_SCHEMA = 1;
export const XROBOT_ENTRY_HEADER = 'User/xrobot_main.hpp';
export const XROBOT_LOCK_FILE = 'xrobot.lock';

// A configuration value: C++ expression text, `null` (not filled in yet), or a YAML
// list/mapping for structured initializers.
export type ValueTree = string | number | boolean | null | ValueTree[] | { [key: string]: ValueTree };

export type NamedValue = Record<string, ValueTree>;

export type DescribeLockModule = {
	id: string;
	commit: string;
	head: string | null;
	status: 'ok' | 'missing' | 'mismatch' | string;
};

export type DescribeLock = {
	path: string;
	present: boolean;
	status: 'ok' | 'missing' | 'mismatch' | 'absent' | string;
	modules: DescribeLockModule[];
};

export type DescribeEntryInput = {
	kind: string;
	path: string;
	recorded: string | null;
	current: string | null;
	status: 'fresh' | 'stale' | 'missing' | string;
};

export type DescribeEntry = {
	path: string;
	status: 'fresh' | 'stale' | 'unstamped' | 'missing' | string;
	tool: string | null;
	inputs: DescribeEntryInput[];
};

export type DescribeParameter = {
	name: string;
	type: string;
	default: string | null;
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
	| { kind: 'class'; constructors: DescribeTypeMember[][] };

export type DescribeInstance = {
	id: string;
	module: string;
	class: string | null;
	template_args: ValueTree[];
	args: NamedValue[];
};

export type DescribeDiagnostic = {
	severity: 'error' | 'warning' | string;
	scope: string;
	message: string;
};

export type DescribeResult = {
	schema: number;
	config: string;
	lock: DescribeLock;
	entry: DescribeEntry;
	registrations: Array<{ name: string; types: string[] }>;
	modules: Record<string, DescribeModule>;
	types: Record<string, DescribeType | null>;
	instances: DescribeInstance[];
	diagnostics: DescribeDiagnostic[];
};

export type XrobotPaths = {
	// Absolute workspace root (BSP root).
	root: string;
	// Workspace-relative paths; CLIs run with cwd = root.
	config: string;
	registerSource?: string;
	header: string;
	lock: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseDescribeOutput(stdout: string): { ok: true; value: DescribeResult } | { ok: false; error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		return { ok: false, error: `invalid JSON from xrobot_describe: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!isRecord(parsed)) {
		return { ok: false, error: 'xrobot_describe did not print a JSON object' };
	}
	if (parsed.schema !== DESCRIBE_SCHEMA) {
		return { ok: false, error: `unsupported xrobot_describe schema ${String(parsed.schema)} (expected ${DESCRIBE_SCHEMA})` };
	}
	const value = parsed as DescribeResult;
	value.modules = isRecord(value.modules) ? value.modules : {};
	value.types = isRecord(value.types) ? value.types : {};
	value.instances = Array.isArray(value.instances) ? value.instances : [];
	value.diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics : [];
	value.registrations = Array.isArray(value.registrations) ? value.registrations : [];
	for (const instance of value.instances) {
		instance.template_args = Array.isArray(instance.template_args) ? instance.template_args : [];
		instance.args = Array.isArray(instance.args) ? instance.args : [];
	}
	return { ok: true, value };
}

// CLI argument builders. Every value is its own argv element; callers must spawn
// without a shell so JSON and C++ text reach the tool unchanged.

export function buildDescribeArgs(paths: XrobotPaths): string[] {
	const args = ['-C', paths.root, '-c', paths.config, '-o', paths.header];
	if (paths.registerSource) {
		args.push('--register-source', paths.registerSource);
	}
	args.push('--lock', paths.lock);
	return args;
}

export function buildGenMainArgs(paths: XrobotPaths): string[] {
	const args = ['-c', paths.config, '-o', paths.header];
	if (paths.registerSource) {
		args.push('--register-source', paths.registerSource);
	}
	args.push('--lock', paths.lock);
	return args;
}

// mode omitted => plain `xrobot_setup` (fetch what is missing, keep the lock).
export function buildSetupArgs(paths: XrobotPaths, mode?: 'frozen' | 'update'): string[] {
	const args = mode ? [`--${mode}`] : [];
	args.push('-c', paths.config);
	if (paths.registerSource) {
		args.push('--register-source', paths.registerSource);
	}
	return args;
}

export function buildInstanceAddArgs(config: string, module: string, id?: string): string[] {
	const args = ['-c', config, 'add', module];
	if (id && id.trim()) {
		args.push('--id', id.trim());
	}
	return args;
}

export type InstanceSetValues = {
	id?: string;
	template_args?: ValueTree[];
	args?: NamedValue[];
};

export function buildInstanceSetArgs(config: string, id: string, values: InstanceSetValues): string[] {
	return ['-c', config, 'set', id, JSON.stringify(values)];
}

export function buildInstanceRemoveArgs(config: string, id: string): string[] {
	return ['-c', config, 'remove', id];
}

// Display-only rendering of a command line (the process itself gets the raw argv).
export function formatCommandLine(cmd: string, args: string[]): string {
	const quote = (arg: string): string => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
	return [cmd, ...args.map(quote)].join(' ');
}

export function isCppIdentifier(value: string): boolean {
	return /^[A-Za-z_][A-Za-z_0-9]*$/.test(value);
}

// Instance args: an ordered list of single-key mappings {param_name: value}.

export function argName(arg: NamedValue): string | undefined {
	const keys = Object.keys(arg ?? {});
	return keys.length === 1 ? keys[0] : undefined;
}

export function argValue(args: NamedValue[], name: string): ValueTree | undefined {
	const entry = args.find((arg) => argName(arg) === name);
	return entry ? entry[name] : undefined;
}

export function argNames(args: NamedValue[]): string[] {
	return args.map((arg) => argName(arg) ?? '?');
}

export function constructorSignature(ctor: DescribeConstructor): string {
	return `(${ctor.parameters.map((p) => `${p.type} ${p.name}`).join(', ')})`;
}

// The constructor whose parameter names equal the instance's arg names, in order.
export function findMatchingConstructor(module: DescribeModule | undefined, args: NamedValue[]): number {
	const ctors = module?.constructors ?? [];
	const names = argNames(args).join('\u0000');
	return ctors.findIndex((ctor) => ctor.parameters.map((p) => p.name).join('\u0000') === names);
}

export function defaultArgsForConstructor(ctor: DescribeConstructor): NamedValue[] {
	return ctor.parameters.map((p) => ({ [p.name]: cloneTree(p.default_fields ?? p.default ?? null) }));
}

export function withArgValue(args: NamedValue[], name: string, value: ValueTree): NamedValue[] {
	let replaced = false;
	const next = args.map((arg) => {
		if (argName(arg) === name) {
			replaced = true;
			return { [name]: value };
		}
		return { ...arg };
	});
	if (!replaced) {
		next.push({ [name]: value });
	}
	return next;
}

export function withTemplateArg(
	current: ValueTree[],
	params: DescribeTemplateParameter[],
	index: number,
	value: ValueTree,
): ValueTree[] {
	const length = Math.max(current.length, params.length, index + 1);
	const next: ValueTree[] = [];
	for (let i = 0; i < length; i += 1) {
		next.push(i < current.length ? current[i] : params[i]?.default ?? null);
	}
	next[index] = value;
	return next;
}

export function cloneTree(value: ValueTree): ValueTree {
	return value === null || typeof value !== 'object' ? value : (JSON.parse(JSON.stringify(value)) as ValueTree);
}

// Mapping shapes: which keys a YAML mapping for a value must use (generator rule:
// designated default fields, else aggregate fields in order, else one constructor's
// parameter names in order).

export type ShapeField = {
	name: string;
	type?: string;
	typeRef?: string | null;
	// Designated default subtree for this field (fixes nested mapping keys).
	defaultTree?: ValueTree;
	// Constructor default text, for class constructor parameters.
	defaultText?: string | null;
};

export type ValueShape =
	| { kind: 'fields'; typeName?: string; fields: ShapeField[] }
	| { kind: 'constructors'; typeName: string; constructors: ShapeField[][] };

function memberFields(members: DescribeTypeMember[]): ShapeField[] {
	return members.map((m) => ({ name: m.name, type: m.type, typeRef: m.type_ref, defaultText: m.default ?? null }));
}

export function typeShape(typeRef: string | null | undefined, types: DescribeResult['types']): ValueShape | undefined {
	if (!typeRef) {
		return undefined;
	}
	const entry = types[typeRef];
	if (!entry) {
		return undefined;
	}
	if (entry.kind === 'aggregate') {
		return { kind: 'fields', typeName: typeRef, fields: memberFields(entry.fields ?? []) };
	}
	if (entry.kind === 'class') {
		const ctors = (entry.constructors ?? []).filter((c) => c.length > 0).map(memberFields);
		return ctors.length > 0 ? { kind: 'constructors', typeName: typeRef, constructors: ctors } : undefined;
	}
	return undefined;
}

// Shape for a value whose designated default is `tree` (a mapping) and whose type is
// `typeRef`; field types are taken from the aggregate when names line up.
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

export function changedEntryInputs(entry: DescribeEntry): DescribeEntryInput[] {
	return (entry.inputs ?? []).filter((input) => input.status !== 'fresh');
}

export function describeSummary(result: DescribeResult): string {
	const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
	const warnings = result.diagnostics.filter((d) => d.severity !== 'error').length;
	return `lock ${result.lock?.status ?? '?'} | entry ${result.entry?.status ?? '?'} | ${errors} errors, ${warnings} warnings`;
}
