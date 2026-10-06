// Which kind of chip project a workspace holds, for the pin layout. Pure (file system only).
//
// The rule is `libxr pins -d`'s own: an STM32CubeMX .ioc in the root is an STM32 project; an
// app.yaml with a .hpmpc under boards/ makes an HPM project; otherwise a SysConfig .syscfg in
// the root makes an MSPM0 project.
import * as fs from 'node:fs';
import * as path from 'node:path';

export type PinsProjectKind = { platform: 'stm32' | 'mspm0' | 'hpm'; source: string };

// The .hpmpc of an HPM project: the first .hpmpc under boards/<board>/, and app.yaml beside the
// boards folder marks the project. Relative to root, with `/`.
export function findHpmpc(root: string): string | undefined {
	if (!fs.existsSync(path.join(root, 'app.yaml'))) {
		return undefined;
	}
	const boards = path.join(root, 'boards');
	let boardFolders: string[] = [];
	try {
		boardFolders = fs
			.readdirSync(boards, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return undefined;
	}
	for (const board of boardFolders) {
		try {
			const found = fs
				.readdirSync(path.join(boards, board), { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.hpmpc'))
				.map((entry) => entry.name)
				.sort();
			if (found.length > 0) {
				return `boards/${board}/${found[0]}`;
			}
		} catch {
			continue;
		}
	}
	return undefined;
}

// The SysConfig project of an MSPM0: the first .syscfg in the root of the workspace (the CLI
// errors when there are several). Relative to root, with `/`.
export function findRootSyscfg(root: string): string | undefined {
	try {
		const found = fs
			.readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.syscfg'))
			.map((entry) => entry.name)
			.sort();
		return found[0];
	} catch {
		return undefined;
	}
}

export function detectPinsProject(root: string, iocFiles: string[]): PinsProjectKind | undefined {
	if (iocFiles.length > 0) {
		return { platform: 'stm32', source: iocFiles[0] };
	}
	const hpmpc = findHpmpc(root);
	if (hpmpc) {
		return { platform: 'hpm', source: hpmpc };
	}
	const syscfg = findRootSyscfg(root);
	return syscfg ? { platform: 'mspm0', source: syscfg } : undefined;
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
