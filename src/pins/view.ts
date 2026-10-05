// What the pin layout webview shows, computed from the `libxr pins` result. Pure.
import { packageGeometry, type PackageGeometry, type PinCell } from './geometry';
import { categoryOf, platformLabel, type Category, type PinsAssignment, type PinsConfig, type PinsResult } from './model';

// The peripheral functions that a pin can carry, from the CLI's own recognition (no second set of
// naming rules here): the pin name -> instance, kind and function.
export type PinFunction = { peripheral: string; kind: string; category: Category; function: string };

export type EntryDetail = {
	name: string;
	type: string;
	functions: PinFunction[];
	gpioModes: string[];
	// MSPM0: the IOMUX register of the pin and the mode of each signal.
	iomuxPincm?: number;
	modes?: Record<string, number | string>;
	assigned?: PinsAssignment;
};

export type PinDetail = { position: string; entries: EntryDetail[] };

export type ViewCell = PinCell & {
	// The text next to or in the cell.
	label: string;
	// CSS classes: free, power, special, or assigned with a category (and mismatch).
	className: string;
	peripheral?: string;
};

export type UsedPeripheral = {
	name: string;
	kind: string;
	category: Category;
	pins: { function: string; pin: string; position: string }[];
	config?: PinsConfig;
};

export type ViewData = {
	title: string;
	subtitle: string;
	source: string;
	geometry: Omit<PackageGeometry, 'cells'> & { cells: ViewCell[] };
	details: Record<string, PinDetail>;
	used: UsedPeripheral[];
	// Whether the result carries a project; without one nothing is selected.
	hasProject: boolean;
	configFile: string | null;
};

// Pin name -> the functions the CLI recognized for it.
function functionsByPin(result: PinsResult): Map<string, PinFunction[]> {
	const index = new Map<string, PinFunction[]>();
	for (const [peripheral, entry] of Object.entries(result.peripherals)) {
		for (const [fn, pins] of Object.entries(entry.signals)) {
			for (const pin of pins) {
				const list = index.get(pin) ?? [];
				list.push({ peripheral, kind: entry.kind, category: categoryOf(entry.kind), function: fn });
				index.set(pin, list);
			}
		}
	}
	return index;
}

function cellClass(result: PinsResult, names: string[]): { className: string; assigned?: PinsAssignment } {
	const assignments = result.project?.assignments ?? {};
	for (const name of names) {
		const assigned = assignments[name];
		if (assigned) {
			const category = categoryOf(assigned.kind);
			return { className: `assigned cat-${category}${assigned.matched ? '' : ' mismatch'}`, assigned };
		}
	}
	const types = names.map((name) => result.pins.find((pin) => pin.name === name)?.type ?? '');
	if (types.includes('Power')) {
		return { className: 'power' };
	}
	if (types.some((type) => type !== 'I/O' && type !== 'Default' && type !== 'MonoIO')) {
		return { className: 'special' };
	}
	return { className: 'free' };
}

export function buildView(result: PinsResult): ViewData {
	const geometry = packageGeometry(result.package, result.pins);
	const functions = functionsByPin(result);
	const pinByName = new Map(result.pins.map((pin) => [pin.name, pin]));
	const positionOfName = new Map(result.pins.map((pin) => [pin.name, pin.position]));

	const details: Record<string, PinDetail> = {};
	for (const pin of result.pins) {
		const detail = details[pin.position] ?? { position: pin.position, entries: [] };
		detail.entries.push({
			name: pin.name,
			type: pin.type,
			functions: functions.get(pin.name) ?? [],
			gpioModes: pin.gpio_modes ?? [],
			...(typeof pin.iomux_pincm === 'number' ? { iomuxPincm: pin.iomux_pincm } : {}),
			...(pin.modes ? { modes: pin.modes } : {}),
			...(result.project?.assignments[pin.name] ? { assigned: result.project.assignments[pin.name] } : {}),
		});
		details[pin.position] = detail;
	}

	const cells: ViewCell[] = geometry.cells.map((cell) => {
		const { className, assigned } = cellClass(result, cell.names);
		const first = pinByName.get(cell.names[0] ?? '');
		return {
			...cell,
			label: assigned?.label ?? first?.name ?? cell.position,
			className,
			...(assigned ? { peripheral: assigned.peripheral } : {}),
		};
	});

	const used: UsedPeripheral[] = Object.entries(result.project?.peripherals ?? {}).map(([name, peripheral]) => ({
		name,
		kind: peripheral.kind,
		category: categoryOf(peripheral.kind),
		pins: Object.entries(peripheral.pins).map(([fn, pin]) => ({
			function: fn,
			pin,
			position: positionOfName.get(pin) ?? '',
		})),
		...(peripheral.config ? { config: peripheral.config } : {}),
	}));
	// What libxr gen generates comes first: peripherals with settings in libxr_config.yaml, then
	// those it would generate but that have none yet, then the rest.
	const rank = (peripheral: UsedPeripheral): number => (peripheral.config ? (peripheral.config.present ? 0 : 1) : 2);
	used.sort((a, b) => rank(a) - rank(b));

	const sourceName = result.source.dataset ?? result.source.vendor ?? '';
	return {
		title: result.part,
		subtitle: `${platformLabel(result.platform)} · ${result.package} · ${result.pin_count} pins`,
		source: `${result.source.vendor ?? ''} ${sourceName}`.trim(),
		geometry: { ...geometry, cells },
		details,
		used,
		hasProject: result.project !== undefined,
		configFile: result.project?.libxr_config ?? null,
	};
}
