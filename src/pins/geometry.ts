// Where each pin of a package is drawn. Pure; the webview only draws what this returns.
//
// Three shapes cover the packages of the STM32 and MSPM0 data:
// - quad: LQFP, QFN and the like, positions 1..N counter-clockwise from the top-left corner,
//   N/4 per side, an exposed pad as the position after N;
// - dual: TSSOP, VSSOP, SOT and the like, positions 1..N/2 down the left, the rest up the right;
// - grid: BGA and WLCSP, positions such as A1, AA12 (and 1A2 on multi-layer BGAs), rows by letter.
import type { PinsPin } from './model';

export type Side = 'left' | 'right' | 'top' | 'bottom' | 'grid' | 'pad' | 'extra';

export type PinCell = {
	// The package position (a pin number or a ball such as A1).
	position: string;
	// Every pin entry at this position (STM32G0 remap puts two on one position).
	names: string[];
	x: number;
	y: number;
	width: number;
	height: number;
	side: Side;
};

export type PackageGeometry = {
	shape: 'quad' | 'dual' | 'grid';
	width: number;
	height: number;
	// The package body.
	body: { x: number; y: number; width: number; height: number };
	// Where the pin 1 mark goes: the corner by pin 1 (the top-left, where position 1 or A1 is).
	marker: { x: number; y: number };
	cells: PinCell[];
};

export const PITCH = 16;
export const PIN_LENGTH = 10;
// Room for the pin names outside the body of a leaded package.
export const LABEL_SPACE = 124;
export const GRID_CELL = 26;

const DUAL_NAMES = /^(TSSOP|SSOP|VSSOP|MSOP|SOP|SOIC|SO\d*|DIP|SOT|WSON|SON|PDIP)/i;
const BALL = /^(\d?)([A-Z]+)(\d+)$/;

// Positions that hold several entries are one cell.
function byPosition(pins: PinsPin[]): Map<string, string[]> {
	const positions = new Map<string, string[]>();
	for (const pin of pins) {
		positions.set(pin.position, [...(positions.get(pin.position) ?? []), pin.name]);
	}
	return positions;
}

function isBall(position: string): boolean {
	return BALL.test(position);
}

export function packageGeometry(packageName: string, pins: PinsPin[]): PackageGeometry {
	const positions = byPosition(pins);
	const keys = [...positions.keys()];
	const balls = keys.filter(isBall).length;
	if (keys.length > 0 && balls * 2 > keys.length) {
		return gridGeometry(positions);
	}
	return leadedGeometry(packageName, positions);
}

// The number of leads: the highest position, less an exposed pad that follows the last lead (one
// past a multiple of the sides), or rounded up to whole sides when positions are missing.
export function pinCount(maxNumber: number, dual: boolean): number {
	const unit = dual ? 2 : 4;
	const remainder = maxNumber % unit;
	if (remainder === 0) {
		return maxNumber;
	}
	return remainder === 1 ? maxNumber - 1 : maxNumber + unit - remainder;
}

function leadedGeometry(packageName: string, positions: Map<string, string[]>): PackageGeometry {
	const numbered = [...positions.keys()].filter((key) => /^\d+$/.test(key)).map(Number);
	const maxNumber = numbered.length > 0 ? Math.max(...numbered) : 0;
	// A name from the dual-in-line families decides; otherwise a pin count that is not a multiple
	// of 4 (and not one past it, an exposed pad) cannot be four equal sides.
	const dual = DUAL_NAMES.test(packageName) || (maxNumber > 0 && maxNumber % 4 !== 0 && maxNumber % 4 !== 1);
	const count = pinCount(maxNumber, dual);
	const perSide = count / (dual ? 2 : 4);

	const cells: PinCell[] = [];
	const bodyHeight = perSide * PITCH + 20;
	const bodyWidth = dual ? Math.round(Math.max(70, bodyHeight / 3)) : bodyHeight;
	const left = LABEL_SPACE;
	const top = dual ? 20 : LABEL_SPACE;
	const body = { x: left, y: top, width: bodyWidth, height: bodyHeight };

	const place = (number: number): PinCell | undefined => {
		const names = positions.get(String(number));
		if (names === undefined) {
			return undefined;
		}
		const index = number - 1;
		let cell: Omit<PinCell, 'position' | 'names'>;
		if (dual) {
			if (index < perSide) {
				cell = { x: left - PIN_LENGTH, y: top + 10 + index * PITCH, width: PIN_LENGTH, height: PITCH - 4, side: 'left' };
			} else {
				const row = perSide - 1 - (index - perSide);
				cell = { x: left + bodyWidth, y: top + 10 + row * PITCH, width: PIN_LENGTH, height: PITCH - 4, side: 'right' };
			}
		} else {
			const side = Math.floor(index / perSide);
			const along = index % perSide;
			if (side === 0) {
				cell = { x: left - PIN_LENGTH, y: top + 10 + along * PITCH, width: PIN_LENGTH, height: PITCH - 4, side: 'left' };
			} else if (side === 1) {
				cell = { x: left + 10 + along * PITCH, y: top + bodyHeight, width: PITCH - 4, height: PIN_LENGTH, side: 'bottom' };
			} else if (side === 2) {
				cell = { x: left + bodyWidth, y: top + 10 + (perSide - 1 - along) * PITCH, width: PIN_LENGTH, height: PITCH - 4, side: 'right' };
			} else {
				cell = { x: left + 10 + (perSide - 1 - along) * PITCH, y: top - PIN_LENGTH, width: PITCH - 4, height: PIN_LENGTH, side: 'top' };
			}
		}
		return { position: String(number), names, ...cell };
	};
	for (let number = 1; number <= count; number += 1) {
		const cell = place(number);
		if (cell) {
			cells.push(cell);
		}
	}
	// Positions after the last pin (the exposed pad) go in the middle of the body; positions that
	// are not numbers go below the package.
	const extras = [...positions.keys()].filter((key) => !/^\d+$/.test(key) || Number(key) > count);
	extras.forEach((key, i) => {
		const pad = /^\d+$/.test(key);
		cells.push({
			position: key,
			names: positions.get(key) ?? [],
			x: pad ? left + bodyWidth / 2 - 20 : left + i * 34,
			y: pad ? top + bodyHeight / 2 - 20 : top + bodyHeight + LABEL_SPACE / 2,
			width: pad ? 40 : 30,
			height: pad ? 40 : 18,
			side: pad ? 'pad' : 'extra',
		});
	});
	const width = left + bodyWidth + LABEL_SPACE;
	const height = top + bodyHeight + (dual ? 30 : LABEL_SPACE) + (extras.some((key) => !/^\d+$/.test(key)) ? 30 : 0);
	return { shape: dual ? 'dual' : 'quad', width, height, body, marker: { x: body.x + 9, y: body.y + 9 }, cells };
}

function gridGeometry(positions: Map<string, string[]>): PackageGeometry {
	const balls = [...positions.keys()].filter(isBall);
	const parsed = balls.map((position) => {
		const match = BALL.exec(position) as RegExpExecArray;
		return { position, layer: match[1], row: match[2], column: Number(match[3]) };
	});
	// Rows by layer, then by length and letters (A..Z, AA..AH): the order of the ball letters.
	const rows = [...new Set(parsed.map((ball) => ball.layer + ball.row))].sort((a, b) => {
		const [la, ra] = [a.match(/^\d?/)?.[0] ?? '', a.replace(/^\d/, '')];
		const [lb, rb] = [b.match(/^\d?/)?.[0] ?? '', b.replace(/^\d/, '')];
		return la.localeCompare(lb) || ra.length - rb.length || ra.localeCompare(rb);
	});
	const columns = [...new Set(parsed.map((ball) => ball.column))].sort((a, b) => a - b);
	const margin = 20;
	const cells: PinCell[] = parsed.map((ball) => ({
		position: ball.position,
		names: positions.get(ball.position) ?? [],
		x: margin + columns.indexOf(ball.column) * GRID_CELL,
		y: margin + rows.indexOf(ball.layer + ball.row) * GRID_CELL,
		width: GRID_CELL - 2,
		height: GRID_CELL - 2,
		side: 'grid',
	}));
	const width = margin * 2 + columns.length * GRID_CELL;
	let height = margin * 2 + rows.length * GRID_CELL;
	// Positions that are not balls go in a row below the grid.
	const others = [...positions.keys()].filter((key) => !isBall(key));
	others.forEach((key, i) => {
		cells.push({
			position: key,
			names: positions.get(key) ?? [],
			x: margin + (i % columns.length) * GRID_CELL,
			y: height + Math.floor(i / columns.length) * GRID_CELL,
			width: GRID_CELL - 2,
			height: GRID_CELL - 2,
			side: 'extra',
		});
	});
	if (others.length > 0) {
		height += Math.ceil(others.length / columns.length) * GRID_CELL + margin;
	}
	return {
		shape: 'grid',
		width,
		height,
		body: { x: margin - 4, y: margin - 4, width: columns.length * GRID_CELL + 6, height: rows.length * GRID_CELL + 6 },
		marker: { x: margin - 4, y: margin - 4 },
		cells,
	};
}
