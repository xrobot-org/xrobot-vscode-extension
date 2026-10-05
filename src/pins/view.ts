// What the pin layout webview shows, computed from the `libxr pins` result. Pure.
import { packageGeometry, type PackageGeometry, type PinCell } from './geometry';
import { categoryOf, channelOf, platformLabel, type Category, type PinsAssignment, type PinsConfig, type PinsResult, type PinsSysconfig } from './model';

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
	// The pin name (always: it says which pin this is).
	label: string;
	// What follows the name: the peripheral function the project selected (USART1.TX), or the label
	// the project gave a GPIO or an external interrupt (ACC_CS); undefined for a free pin.
	functionLabel?: string;
	// CSS classes: free, power, special, or assigned with a category (and mismatch).
	className: string;
	// The legend entry of the cell: a category of a selected pin, or free, power, special.
	legend: string;
	peripheral?: string;
};

// One function of a peripheral, with the pins that can carry it and the one the project uses.
export type PeripheralFunction = { function: string; pins: string[]; current?: string };

export type PeripheralDetail = {
	kind: string;
	category: Category;
	functions: PeripheralFunction[];
	config?: PinsConfig;
	sysconfig?: PinsSysconfig;
	capabilities: string[];
	// Whether the project selected a pin of it.
	used: boolean;
};

export type UsedPeripheral = {
	name: string;
	kind: string;
	category: Category;
	pins: { function: string; pin: string; position: string }[];
	config?: PinsConfig;
	sysconfig?: PinsSysconfig;
};

export type ViewData = {
	title: string;
	subtitle: string;
	source: string;
	geometry: Omit<PackageGeometry, 'cells'> & { cells: ViewCell[] };
	details: Record<string, PinDetail>;
	// Pin name -> position on the package.
	positions: Record<string, string>;
	// Every recognized peripheral (the CLI's recognition), by instance name.
	peripherals: Record<string, PeripheralDetail>;
	platform: string;
	// Whether the result carries a project; without one nothing is selected.
	hasProject: boolean;
	configFile: string | null;
	// The .syscfg of an MSPM0 project, relative to the project.
	sysconfigFile: string | null;
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

function cellClass(result: PinsResult, names: string[]): { className: string; legend: string; assigned?: PinsAssignment } {
	const assignments = result.project?.assignments ?? {};
	for (const name of names) {
		const assigned = assignments[name];
		if (assigned) {
			// XRobot Style has four data colours: the other categories share "other".
			const channel = channelOf(categoryOf(assigned.kind));
			return { className: `assigned cat-${channel}${assigned.matched ? '' : ' mismatch'}`, legend: channel, assigned };
		}
	}
	const types = names.map((name) => result.pins.find((pin) => pin.name === name)?.type ?? '');
	if (types.includes('Power')) {
		return { className: 'power', legend: 'power' };
	}
	if (types.some((type) => type !== 'I/O' && type !== 'Default' && type !== 'MonoIO')) {
		return { className: 'special', legend: 'special' };
	}
	return { className: 'free', legend: 'free' };
}

// What libxr gen generates comes first: peripherals with settings in libxr_config.yaml, then those
// it would generate but that have none yet, then the rest. Used by the panel and the tree.
export function usedPeripherals(result: PinsResult): UsedPeripheral[] {
	const positionOfName = new Map(result.pins.map((pin) => [pin.name, pin.position]));
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
		...(peripheral.sysconfig ? { sysconfig: peripheral.sysconfig } : {}),
	}));
	const rank = (peripheral: UsedPeripheral): number => (peripheral.config ? (peripheral.config.present ? 0 : 1) : 2);
	return used.sort((a, b) => rank(a) - rank(b));
}

// A GPIO or an external interrupt is shown by the label the project gave it, if any (its port and
// line are the pin name); any other peripheral by its instance and function.
function functionLabelOf(assigned: PinsAssignment): { functionLabel?: string } {
	if (assigned.kind === 'GPIO' || assigned.kind === 'EXTI') {
		return assigned.label ? { functionLabel: assigned.label } : {};
	}
	return { functionLabel: `${assigned.peripheral}.${assigned.function}` };
}

export function buildView(result: PinsResult): ViewData {
	const geometry = packageGeometry(result.package, result.pins);
	const functions = functionsByPin(result);
	const pinByName = new Map(result.pins.map((pin) => [pin.name, pin]));
	const positions = Object.fromEntries(result.pins.map((pin) => [pin.name, pin.position]));

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
		const { className, legend, assigned } = cellClass(result, cell.names);
		const first = pinByName.get(cell.names[0] ?? '');
		return {
			...cell,
			label: first?.name ?? cell.position,
			className,
			legend,
			...(assigned ? { peripheral: assigned.peripheral } : {}),
			...(assigned ? functionLabelOf(assigned) : {}),
		};
	});

	const peripherals: Record<string, PeripheralDetail> = {};
	for (const [name, entry] of Object.entries(result.peripherals)) {
		const project = result.project?.peripherals[name];
		peripherals[name] = {
			kind: entry.kind,
			category: categoryOf(entry.kind),
			functions: Object.entries(entry.signals).map(([fn, pins]) => ({
				function: fn,
				pins,
				...(project?.pins[fn] ? { current: project.pins[fn] } : {}),
			})),
			...(project?.config ? { config: project.config } : {}),
			...(project?.sysconfig ? { sysconfig: project.sysconfig } : {}),
			capabilities: entry.capabilities ?? [],
			used: project !== undefined,
		};
	}

	const sourceName = result.source.dataset ?? result.source.vendor ?? '';
	return {
		title: result.part,
		subtitle: `${platformLabel(result.platform)} · ${result.package} · ${result.pin_count} pins`,
		source: `${result.source.vendor ?? ''} ${sourceName}`.trim(),
		geometry: { ...geometry, cells },
		details,
		positions,
		peripherals,
		platform: result.platform,
		hasProject: result.project !== undefined,
		configFile: result.project?.libxr_config ?? null,
		sysconfigFile: result.project?.sysconfig_file ?? null,
	};
}
