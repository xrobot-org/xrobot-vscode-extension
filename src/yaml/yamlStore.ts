import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';

export function parseYamlSafe(filePath: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		const raw = fs.readFileSync(filePath, 'utf8');
		return { ok: true, value: parseYaml(raw) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}
