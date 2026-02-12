import * as fs from 'node:fs';
import * as path from 'node:path';

function toWorkspacePath(root: string, abs: string): string {
	const rel = path.relative(root, abs).replace(/\\/g, '/');
	return rel.startsWith('..') ? abs : rel;
}

function discoverUserYamlConfigsByKind(root: string, kind: 'xrobot' | 'libxr'): string[] {
	const userDir = path.join(root, 'User');
	if (!fs.existsSync(userDir)) {
		return [];
	}
	const result: string[] = [];
	const stack: string[] = [userDir];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const abs = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(abs);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			const lower = entry.name.toLowerCase();
			if (!(lower.endsWith('.yaml') || lower.endsWith('.yml'))) {
				continue;
			}
			if (kind === 'xrobot') {
				// Avoid treating unrelated YAMLs (e.g. generated ".config.yaml") as XRobot configs.
				// XRobot configs must include "xrobot" in the filename (and must not be libxr configs).
				if (lower.includes('libxr')) {
					continue;
				}
				if (!lower.includes('xrobot')) {
					continue;
				}
			} else if (!lower.includes('libxr')) {
				continue;
			}
			result.push(toWorkspacePath(root, abs));
		}
	}
	result.sort((a, b) => a.localeCompare(b));
	return result;
}

export function discoverUserXrobotConfigs(root: string): string[] {
	return discoverUserYamlConfigsByKind(root, 'xrobot');
}

export function discoverUserLibxrConfigs(root: string): string[] {
	return discoverUserYamlConfigsByKind(root, 'libxr');
}
