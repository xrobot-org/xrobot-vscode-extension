// User/flash_map.hpp as `libxr gen` writes it: the MCU in a `// MCU:` comment and the
// internal Flash as FLASH_REGIONS, runs of equal sectors {address, sector size, count}.
// No `vscode` import (unit-tested).
import * as fs from 'node:fs';

export type FlashRun = { address: number; sectorSize: number; sectorCount: number };

export type FlashMap = { mcu?: string; runs: FlashRun[] };

const NUMBER = String.raw`(0[xX][0-9a-fA-F]+|\d+)[uU]?`;
const RUN = new RegExp(String.raw`\{\s*${NUMBER}\s*,\s*${NUMBER}\s*,\s*${NUMBER}\s*\}`, 'g');

export function parseFlashMap(text: string): FlashMap | undefined {
	const table = /FLASH_REGIONS\s*\[\s*\]\s*=\s*\{([\s\S]*?)\};/.exec(text);
	if (!table) {
		return undefined;
	}
	const runs = [...table[1].matchAll(RUN)].map((m) => ({
		address: Number(m[1]),
		sectorSize: Number(m[2]),
		sectorCount: Number(m[3]),
	}));
	const mcu = /^\/\/\s*MCU:\s*(\S+)/m.exec(text)?.[1];
	return { mcu, runs };
}

export function readFlashMap(file: string): FlashMap | undefined {
	try {
		return parseFlashMap(fs.readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

export function flashMapSize(map: FlashMap): number {
	return map.runs.reduce((sum, run) => sum + run.sectorSize * run.sectorCount, 0);
}

export function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) {
		return `${bytes / (1024 * 1024)} MB`;
	}
	if (bytes % 1024 === 0) {
		return `${bytes / 1024} KB`;
	}
	return `${bytes} B`;
}

export function formatAddress(address: number): string {
	return `0x${address.toString(16).toUpperCase().padStart(8, '0')}`;
}

// One line per run, e.g. "0x08000000: 16 KB x 4".
export function formatRun(run: FlashRun): string {
	return `${formatAddress(run.address)}: ${formatBytes(run.sectorSize)} x ${run.sectorCount}`;
}
