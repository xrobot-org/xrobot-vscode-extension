import * as fs from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import { asRecord, parseYamlSafe } from '../yaml/yamlStore';

type WriteStage = 'read' | 'write' | 'validate';

export type GuardedYamlWriteFailure = {
	ok: false;
	stage: WriteStage;
	error: string;
	rollbackError?: string;
};

export type GuardedYamlWriteResult = { ok: true } | GuardedYamlWriteFailure;

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function guardedWriteYamlRoot(
	filePath: string,
	root: Record<string, unknown>,
	validate: (parsedRoot: Record<string, unknown>) => boolean,
): GuardedYamlWriteResult {
	let previousRaw = '';
	try {
		previousRaw = fs.readFileSync(filePath, 'utf8');
	} catch (error) {
		return { ok: false, stage: 'read', error: toErrorMessage(error) };
	}

	try {
		fs.writeFileSync(filePath, stringifyYaml(root), 'utf8');
	} catch (error) {
		return { ok: false, stage: 'write', error: toErrorMessage(error) };
	}

	const parsed = parseYamlSafe(filePath);
	const parsedRoot = parsed.ok ? asRecord(parsed.value) : undefined;
	if (parsed.ok && parsedRoot && validate(parsedRoot)) {
		return { ok: true };
	}

	let rollbackError: string | undefined;
	try {
		fs.writeFileSync(filePath, previousRaw, 'utf8');
	} catch (error) {
		rollbackError = toErrorMessage(error);
	}

	const parseError = parsed.ok ? 'validation failed' : parsed.error;
	return { ok: false, stage: 'validate', error: parseError, rollbackError };
}
