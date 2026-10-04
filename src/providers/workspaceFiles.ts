// Modules/modules.yaml and Modules/sources.yaml as shown in the XRobot view.
// No `vscode` import (unit-tested).
//
// Module requests are changed only through `xrobot module add|remove`. The CLI has no
// command to change a source's priority/URL or to remove a source, so those two edits
// are made here: by the source's URL (never by display position), through the YAML
// document model (comments and the other entries stay as written), and never on a
// protected (official) source.
import * as fs from 'node:fs';
import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument } from 'yaml';

export const PROTECTED_SOURCE_URLS = [
	'https://xrobot.work/xrobot-modules/index.yaml',
	'https://xrobot-org.github.io/xrobot-modules/index.yaml',
];

export function isProtectedSourceUrl(url: string): boolean {
	const normalized = url.trim().replace(/\/+$/, '');
	return PROTECTED_SOURCE_URLS.includes(normalized);
}

export type ModuleRequest = {
	id: string;
	ref?: string;
	// Written as `owner/Repo@ref` (as `xrobot module add` writes it); mapping requests
	// ({id, ref, context_ref}) are shown but their ref is changed in the file itself.
	plain: boolean;
};

export type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

function readText(file: string): ReadResult<string> {
	try {
		return { ok: true, value: fs.readFileSync(file, 'utf8') };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function readModuleRequests(file: string): ReadResult<ModuleRequest[]> {
	const text = readText(file);
	if (!text.ok) {
		return text;
	}
	let data: unknown;
	try {
		data = parseYaml(text.value);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const list = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).modules : undefined;
	if (list !== undefined && list !== null && !Array.isArray(list)) {
		return { ok: false, error: 'modules must be a list of package requests' };
	}
	const requests: ModuleRequest[] = [];
	for (const entry of (list as unknown[] | undefined) ?? []) {
		if (typeof entry === 'string') {
			const at = entry.indexOf('@');
			requests.push(at < 0 ? { id: entry, plain: true } : { id: entry.slice(0, at), ref: entry.slice(at + 1), plain: true });
		} else if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).id === 'string') {
			const record = entry as Record<string, unknown>;
			requests.push({ id: String(record.id), ref: record.ref === undefined || record.ref === null ? undefined : String(record.ref), plain: false });
		}
	}
	return { ok: true, value: requests };
}

export type SourceEntry = {
	url: string;
	priority: number;
	protected: boolean;
};

export function readSources(file: string): ReadResult<SourceEntry[]> {
	const text = readText(file);
	if (!text.ok) {
		return text;
	}
	let data: unknown;
	try {
		data = parseYaml(text.value);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const list = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).sources : undefined;
	if (list !== undefined && list !== null && !Array.isArray(list)) {
		return { ok: false, error: 'sources must be a list' };
	}
	const sources: SourceEntry[] = [];
	for (const entry of (list as unknown[] | undefined) ?? []) {
		if (!entry || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).url !== 'string') {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const priority = Number(record.priority ?? 0);
		const url = String(record.url);
		sources.push({ url, priority: Number.isFinite(priority) ? priority : 0, protected: isProtectedSourceUrl(url) });
	}
	// The CLI orders sources by priority (stable); the view shows them in that order.
	return { ok: true, value: sources.map((s, i) => ({ s, i })).sort((a, b) => a.s.priority - b.s.priority || a.i - b.i).map(({ s }) => s) };
}

export type SourceEdit = { kind: 'priority'; priority: number } | { kind: 'url'; url: string } | { kind: 'remove' };

// Applies one edit to the source whose url is `url`. Throws with a user-facing message
// when the source is protected, absent or ambiguous; the file is then unchanged.
export function editSource(file: string, url: string, edit: SourceEdit): void {
	if (isProtectedSourceUrl(url)) {
		throw new Error(`${url} is the official source and cannot be changed`);
	}
	if (edit.kind === 'url' && isProtectedSourceUrl(edit.url)) {
		throw new Error(`${edit.url} is the official source; it cannot be the target of an edit`);
	}
	const text = fs.readFileSync(file, 'utf8');
	const doc = parseDocument(text);
	if (doc.errors.length > 0) {
		throw new Error(`${file}: ${doc.errors[0].message}`);
	}
	const seq = doc.get('sources');
	if (!isSeq(seq)) {
		throw new Error(`${file} has no sources list`);
	}
	const matches = seq.items
		.map((item, index) => ({ item, index }))
		.filter(({ item }) => isMap(item) && sourceUrl(item.get('url', true)) === url);
	if (matches.length === 0) {
		throw new Error(`${url} is not in ${file}`);
	}
	if (matches.length > 1) {
		throw new Error(`${url} is listed ${matches.length} times in ${file}; remove the duplicate first`);
	}
	const { item, index } = matches[0];
	if (!isMap(item)) {
		return;
	}
	if (edit.kind === 'remove') {
		seq.delete(index);
	} else if (edit.kind === 'priority') {
		item.set('priority', edit.priority);
	} else {
		const others = seq.items.filter((other, i) => i !== index && isMap(other) && sourceUrl(other.get('url', true)) === edit.url);
		if (others.length > 0) {
			throw new Error(`${edit.url} is already listed in ${file}`);
		}
		item.set('url', edit.url);
	}
	// Keep the file's own layout: sequence indentation, no line folding, line endings.
	const indentSeq = !/^sources:[ \t]*(#.*)?\r?\n(?:[ \t]*(#.*)?\r?\n)*-/m.test(text);
	let out = doc.toString({ indentSeq, lineWidth: 0 });
	if (text.includes('\r\n')) {
		out = out.replace(/\r?\n/g, '\r\n');
	}
	fs.writeFileSync(file, out, 'utf8');
}

function sourceUrl(node: unknown): string | undefined {
	if (isScalar(node)) {
		return node.value === null || node.value === undefined ? undefined : String(node.value);
	}
	return typeof node === 'string' ? node : undefined;
}
