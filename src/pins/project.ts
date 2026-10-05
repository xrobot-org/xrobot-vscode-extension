// Which kind of chip project a workspace holds, for the pin layout. Pure (file system only).
//
// The rule is `libxr pins -d`'s own: an STM32CubeMX .ioc in the root is an STM32 project;
// otherwise the ti_msp_dl_config.h of SysConfig makes an MSPM0 project.
import * as fs from 'node:fs';
import * as path from 'node:path';

export type PinsProjectKind = { platform: 'stm32' | 'mspm0'; source: string };

const SKIPPED_FOLDERS = new Set(['build', 'cmake-build']);

function directories(folder: string): string[] {
	try {
		return fs
			.readdirSync(folder, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

// The ti_msp_dl_config.h SysConfig generated: the root and sysconfig/ first, then up to three
// levels down, never inside a build folder. Relative to root, with `/`.
export function findTiHeader(root: string): string | undefined {
	for (const candidate of ['ti_msp_dl_config.h', 'sysconfig/ti_msp_dl_config.h']) {
		if (fs.existsSync(path.join(root, candidate))) {
			return candidate;
		}
	}
	const top = directories(root).filter((name) => !SKIPPED_FOLDERS.has(name));
	for (const depth of [2, 3]) {
		const found = descend(root, top, depth);
		if (found) {
			return found;
		}
	}
	return undefined;
}

// Headers `depth` folders below root (the CLI looks at */*/ and */*/*/).
function descend(root: string, top: string[], depth: number): string | undefined {
	let level = top.map((name) => name);
	for (let i = 1; i < depth; i += 1) {
		level = level.flatMap((relative) =>
			directories(path.join(root, relative))
				.filter((name) => !SKIPPED_FOLDERS.has(name))
				.map((name) => `${relative}/${name}`),
		);
	}
	for (const relative of level) {
		const candidate = `${relative}/ti_msp_dl_config.h`;
		if (fs.existsSync(path.join(root, candidate))) {
			return candidate;
		}
	}
	return undefined;
}

export function detectPinsProject(root: string, iocFiles: string[]): PinsProjectKind | undefined {
	if (iocFiles.length > 0) {
		return { platform: 'stm32', source: iocFiles[0] };
	}
	const header = findTiHeader(root);
	return header ? { platform: 'mspm0', source: header } : undefined;
}

// The .ioc files in the root of a workspace, sorted (the CLI takes the first).
export function listIocFiles(root: string): string[] {
	try {
		return fs
			.readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ioc'))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}
