import * as fs from 'node:fs';
import * as path from 'node:path';

// LibXR configs selectable in the LibXR view: YAML files under User/ whose name contains
// "libxr". (XRobot application configs are listed by `xrobot describe`.)
export function discoverUserLibxrConfigs(root: string): string[] {
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
			const lower = entry.name.toLowerCase();
			if (entry.isFile() && (lower.endsWith('.yaml') || lower.endsWith('.yml')) && lower.includes('libxr')) {
				result.push(path.relative(root, abs).replace(/\\/g, '/'));
			}
		}
	}
	return result.sort((a, b) => a.localeCompare(b));
}
