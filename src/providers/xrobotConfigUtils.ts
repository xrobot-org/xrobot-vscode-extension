import * as fs from 'node:fs';
import { asRecord, parseYamlSafe } from '../yaml/yamlStore';

function readYamlRoot(filePath: string): Record<string, unknown> | undefined {
	if (!fs.existsSync(filePath)) {
		return undefined;
	}
	const parsed = parseYamlSafe(filePath);
	if (!parsed.ok) {
		return undefined;
	}
	return asRecord(parsed.value);
}

export function isLikelyXrobotConfig(root: Record<string, unknown>): boolean {
	if (Array.isArray(root.modules)) {
		return true;
	}
	if (asRecord(root.global_settings)) {
		return true;
	}
	return false;
}

export function hasUsableXrobotConfig(configPath: string): boolean {
	if (!fs.existsSync(configPath)) {
		return false;
	}
	const root = readYamlRoot(configPath);
	if (!root) {
		return false;
	}
	return isLikelyXrobotConfig(root);
}
