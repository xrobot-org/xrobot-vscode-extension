// The pin layout webview: draws the package from the geometry the extension computed, searches and
// filters it, and shows the pin or the peripheral that is selected. Text is set with textContent
// only; the data comes from the CLI and from project files.
(function () {
	'use strict';
	const vscode = acquireVsCodeApi();
	const SVG = 'http://www.w3.org/2000/svg';
	const app = document.getElementById('app');

	const LEGEND = [
		['comm', 'Communication'],
		['timer', 'Timer'],
		['analog', 'Analog'],
		['gpio', 'GPIO'],
		['system', 'System'],
		['memory', 'Memory'],
		['other', 'Other'],
		['free', 'Not selected'],
		['power', 'Power'],
		['special', 'Special'],
	];
	const CATEGORY_NAMES = Object.fromEntries(LEGEND);

	let data;
	// null fits the package to the window; a number is a zoom the user chose.
	let zoom = null;
	let query = '';
	let showFunctions = true;
	const filters = new Set();
	let selectedPosition;
	let selectedPeripheral;
	let pendingPeripheral;
	let searchText = new Map();

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		return node;
	}

	function svg(tag, attributes, text) {
		const node = document.createElementNS(SVG, tag);
		for (const [name, value] of Object.entries(attributes || {})) {
			node.setAttribute(name, String(value));
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		return node;
	}

	// ---- search -------------------------------------------------------------------------------

	// Everything a pin answers to: its names, position, what the project selected and every
	// function it can carry.
	function buildSearchText() {
		searchText = new Map();
		for (const detail of Object.values(data.details)) {
			const words = [detail.position];
			for (const entry of detail.entries) {
				words.push(entry.name);
				if (entry.assigned) {
					const a = entry.assigned;
					words.push(a.signal, a.peripheral, a.function, a.label || '');
				}
				for (const fn of entry.functions) {
					words.push(`${fn.peripheral}.${fn.function}`, `${fn.peripheral}_${fn.function}`, fn.peripheral);
				}
			}
			searchText.set(detail.position, words.join(' ').toLowerCase());
		}
	}

	function matchesQuery(position) {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		const text = searchText.get(position) || '';
		return terms.every((term) => text.includes(term));
	}

	function candidatePositions() {
		const result = new Map();
		const peripheral = selectedPeripheral && data.peripherals[selectedPeripheral];
		if (!peripheral) {
			return result;
		}
		for (const fn of peripheral.functions) {
			for (const name of fn.pins) {
				const position = data.positions[name];
				if (position) {
					result.set(position, fn.current === name ? 'current' : 'candidate');
				}
			}
		}
		return result;
	}

	// ---- layout -------------------------------------------------------------------------------

	function render() {
		app.replaceChildren();
		if (data.error) {
			app.append(el('p', 'error', data.error));
			return;
		}
		app.append(toolbar(), legend());
		const main = el('div', 'main');
		const canvas = el('div', 'package');
		canvas.id = 'package';
		const side = el('aside');
		side.id = 'side';
		main.append(canvas, side);
		app.append(main);
		drawPackage();
		drawSide();
	}

	function toolbar() {
		const bar = el('header');
		bar.append(el('h1', undefined, data.title), el('span', 'subtitle', data.subtitle));
		const tools = el('span', 'tools');
		const search = el('input');
		search.type = 'search';
		search.placeholder = 'Search pin, signal, peripheral';
		search.value = query;
		search.addEventListener('input', () => {
			query = search.value;
			restyle();
			count.textContent = matchCount();
		});
		const count = el('span', 'dim', matchCount());
		tools.append(search, count);
		if (data.hasProject) {
			const label = el('button', undefined, showFunctions ? 'Names + functions' : 'Names');
			label.title = 'What the pin labels show';
			label.addEventListener('click', () => {
				showFunctions = !showFunctions;
				label.textContent = showFunctions ? 'Names + functions' : 'Names';
				drawPackage();
			});
			tools.append(label);
		}
		for (const [text, factor, title] of [['−', 0.8, 'Zoom out'], ['+', 1.25, 'Zoom in'], ['Fit', 0, 'Fit to the window']]) {
			const button = el('button', undefined, text);
			button.title = title;
			button.addEventListener('click', () => {
				zoom = factor === 0 ? null : Math.min(5, Math.max(0.3, (zoom === null ? currentScale() : zoom) * factor));
				drawPackage();
			});
			tools.append(button);
		}
		bar.append(tools);
		return bar;
	}

	function matchCount() {
		if (!query.trim()) {
			return '';
		}
		const n = data.geometry.cells.filter((cell) => matchesQuery(cell.position)).length;
		return `${n} pin${n === 1 ? '' : 's'}`;
	}

	function legend() {
		const bar = el('div', 'legend');
		const present = new Set(data.geometry.cells.map((cell) => cell.legend));
		for (const [key, name] of LEGEND) {
			if (!present.has(key)) {
				continue;
			}
			const chip = el('button', `chip cat-${key}${filters.has(key) ? ' on' : ''}`, name);
			chip.title = 'Show only these pins';
			chip.addEventListener('click', () => {
				if (filters.has(key)) {
					filters.delete(key);
				} else {
					filters.add(key);
				}
				chip.classList.toggle('on');
				restyle();
			});
			bar.append(chip);
		}
		return bar;
	}

	// ---- package ------------------------------------------------------------------------------

	function currentScale() {
		const g = data.geometry;
		const host = document.getElementById('package');
		const width = host ? host.clientWidth - 4 : 600;
		const height = Math.max(300, window.innerHeight - 190);
		return Math.min(width / g.width, height / g.height, 1.6);
	}

	function shortLabel(text, max) {
		const base = text.replace(/\(.*$/, '');
		return base.length > max ? `${base.slice(0, max - 1)}…` : base;
	}

	function cellText(cell) {
		if (showFunctions && cell.functionLabel) {
			return `${cell.label} ${cell.functionLabel}`;
		}
		return cell.label;
	}

	function labelFor(cell) {
		const { x, y, width, height, side } = cell;
		const cx = x + width / 2;
		const cy = y + height / 2;
		const text = shortLabel(cellText(cell), 22);
		switch (side) {
			case 'left':
				return svg('text', { x: x - 4, y: cy + 3, 'text-anchor': 'end', class: 'name' }, text);
			case 'right':
				return svg('text', { x: x + width + 4, y: cy + 3, class: 'name' }, text);
			case 'top':
				return svg('text', { transform: `translate(${cx + 3} ${y - 4}) rotate(-90)`, class: 'name' }, text);
			case 'bottom':
				return svg('text', { transform: `translate(${cx - 3} ${y + height + 4}) rotate(90)`, class: 'name' }, text);
			default:
				return svg('text', { x: cx, y: cy + 2.5, 'text-anchor': 'middle', class: 'ball' }, shortLabel(cell.label.split('-')[0], 5));
		}
	}

	function drawPackage() {
		const host = document.getElementById('package');
		host.replaceChildren();
		const g = data.geometry;
		const scale = zoom === null ? currentScale() : zoom;
		const canvas = svg('svg', { viewBox: `0 0 ${g.width} ${g.height}`, width: g.width * scale, height: g.height * scale });
		canvas.append(svg('rect', { class: 'body', x: g.body.x, y: g.body.y, width: g.body.width, height: g.body.height, rx: 4 }));
		canvas.append(svg('circle', { class: 'pin1', cx: g.marker.x, cy: g.marker.y, r: 3.2 }));
		canvas.append(svg('text', { class: 'chip', x: g.body.x + g.body.width / 2, y: g.body.y + g.body.height / 2, 'text-anchor': 'middle' }, data.title));
		for (const cell of g.cells) {
			const group = svg('g', { class: `cell ${cell.className}` });
			group.dataset.position = cell.position;
			group.dataset.legend = cell.legend;
			group.append(svg('title', {}, `${cell.position}: ${cell.names.join(' / ')}${cell.functionLabel ? ` — ${cell.functionLabel}` : ''}`));
			group.append(svg('rect', { x: cell.x, y: cell.y, width: cell.width, height: cell.height, rx: 1.5 }));
			group.append(labelFor(cell));
			group.addEventListener('click', () => {
				selectedPosition = cell.position;
				restyle();
				drawSide();
			});
			canvas.append(group);
		}
		host.append(canvas);
		restyle();
	}

	// Selection, search, filters and the candidates of a selected peripheral change classes only,
	// so the drawing is not rebuilt for them.
	function restyle() {
		const searching = query.trim().length > 0;
		const candidates = candidatePositions();
		for (const group of document.querySelectorAll('#package .cell')) {
			const position = group.dataset.position;
			const hit = (!searching || matchesQuery(position)) && (filters.size === 0 || filters.has(group.dataset.legend));
			const mark = candidates.get(position);
			group.classList.toggle('dimmed', !hit || (candidates.size > 0 && !mark && !searching));
			group.classList.toggle('selected', position === selectedPosition);
			group.classList.toggle('candidate', mark === 'candidate');
			group.classList.toggle('current', mark === 'current');
			group.classList.toggle('match', searching && hit);
		}
	}

	// ---- inspector ----------------------------------------------------------------------------

	function row(label, value) {
		const line = el('div', 'row');
		line.append(el('span', 'k', label), el('span', 'v', value));
		return line;
	}

	function paramsTable(config) {
		const box = el('div', 'config');
		box.append(el('div', 'row head', `${config.section}.${config.key}`));
		if (!config.present) {
			box.append(el('div', 'row dim', 'not in libxr_config.yaml'));
		} else {
			for (const [name, value] of Object.entries(config.params || {})) {
				box.append(row(name, typeof value === 'object' ? JSON.stringify(value) : String(value)));
			}
		}
		if (data.configFile) {
			const open = el('button', 'link', 'Open libxr_config.yaml');
			open.addEventListener('click', () => vscode.postMessage({ type: 'openConfig' }));
			box.append(open);
		}
		return box;
	}

	function selectPeripheral(name) {
		selectedPeripheral = selectedPeripheral === name ? undefined : name;
		restyle();
		drawSide();
	}

	function peripheralLink(name, className) {
		const link = el('button', `link ${className || ''}`, name);
		link.title = 'Show its functions and the pins that can carry them';
		link.addEventListener('click', () => selectPeripheral(name));
		return link;
	}

	// The functions a pin can carry, by category; the category of the selected signal is open.
	function canBe(entry) {
		const wrap = el('div', 'canbe');
		const groups = new Map();
		for (const fn of entry.functions) {
			groups.set(fn.category, [...(groups.get(fn.category) || []), fn]);
		}
		const order = LEGEND.map(([key]) => key).filter((key) => groups.has(key));
		const total = entry.functions.length;
		const assignedCategory = entry.assigned && data.peripherals[entry.assigned.peripheral] && data.peripherals[entry.assigned.peripheral].category;
		for (const category of order) {
			const functions = groups.get(category);
			const details = el('details');
			details.open = total <= 6 || category === assignedCategory;
			details.append(el('summary', `cat-${category}`, `${CATEGORY_NAMES[category]} (${functions.length})`));
			const byPeripheral = new Map();
			for (const fn of functions) {
				byPeripheral.set(fn.peripheral, [...(byPeripheral.get(fn.peripheral) || []), fn]);
			}
			for (const [peripheral, list] of byPeripheral) {
				const line = el('div', `fn cat-${category}`);
				line.append(peripheralLink(peripheral, 'peripheral'));
				for (const fn of list) {
					const mode = entry.modes && entry.modes[`${peripheral}.${fn.function}`];
					line.append(el('span', 'chip-fn', mode === undefined ? fn.function : `${fn.function} (${mode})`));
				}
				details.append(line);
			}
			wrap.append(details);
		}
		return wrap;
	}

	function drawEntry(entry) {
		const box = el('section', 'entry');
		box.append(el('h3', undefined, entry.name));
		box.append(row('type', entry.type));
		if (entry.gpioModes.length > 0) {
			box.append(row('GPIO', entry.gpioModes.join(', ')));
		}
		if (entry.iomuxPincm !== undefined) {
			box.append(row('IOMUX', `PINCM${entry.iomuxPincm}`));
		}
		if (entry.assigned) {
			const a = entry.assigned;
			const selected = el('div', `selected-signal${a.matched ? '' : ' mismatch'}`);
			selected.append(el('strong', undefined, 'Selected: '), document.createTextNode(`${a.signal} → `), peripheralLink(a.peripheral), document.createTextNode(` ${a.function}`));
			if (a.label) {
				selected.append(el('div', 'dim', `label ${a.label}`));
			}
			if (!a.matched) {
				selected.append(el('div', 'dim', 'not a signal of this pin'));
			}
			if (a.candidates) {
				selected.append(el('div', 'dim', `could be ${a.candidates.join(', ')}`));
			}
			box.append(selected);
			const peripheral = data.peripherals[a.peripheral];
			if (peripheral && peripheral.config) {
				box.append(paramsTable(peripheral.config));
			}
		}
		if (entry.functions.length > 0) {
			box.append(el('h4', undefined, 'Can be'), canBe(entry));
		}
		return box;
	}

	function drawPeripheral(name) {
		const peripheral = data.peripherals[name];
		const box = el('section', 'entry peripheral-inspector');
		const title = el('h3');
		title.append(document.createTextNode(`${name} `), el('span', `kind cat-${peripheral.category}`, peripheral.kind));
		const clear = el('button', 'link', '×');
		clear.title = 'Clear';
		clear.addEventListener('click', () => selectPeripheral(name));
		title.append(clear);
		box.append(title);
		if (peripheral.capabilities.length > 0) {
			box.append(row('can', peripheral.capabilities.join(', ')));
		}
		if (peripheral.config) {
			box.append(paramsTable(peripheral.config));
		}
		const table = el('div', 'functions');
		for (const fn of peripheral.functions) {
			const line = el('div', 'function');
			line.append(el('span', 'fname', fn.function));
			const pins = el('span', 'fpins');
			for (const pin of fn.pins) {
				const chip = el('button', `pinchip${fn.current === pin ? ' current' : ''}`, pin.replace(/\(.*$/, ''));
				chip.title = `${data.positions[pin]}: ${pin}`;
				chip.addEventListener('click', () => {
					selectedPosition = data.positions[pin];
					restyle();
					drawSide();
				});
				pins.append(chip);
			}
			line.append(pins);
			table.append(line);
		}
		box.append(table);
		return box;
	}

	function drawSide() {
		const side = document.getElementById('side');
		side.replaceChildren();
		const detail = selectedPosition && data.details[selectedPosition];
		if (detail) {
			side.append(el('h2', undefined, `Pin ${detail.position}`));
			for (const entry of detail.entries) {
				side.append(drawEntry(entry));
			}
		}
		if (selectedPeripheral && data.peripherals[selectedPeripheral]) {
			side.append(el('h2', undefined, 'Peripheral'), drawPeripheral(selectedPeripheral));
		}
		if (!detail && !selectedPeripheral) {
			side.append(el('p', 'dim', 'Click a pin, or search for a signal.'));
		}
		side.append(el('p', 'dim source', data.source));
	}

	// ---- messages -----------------------------------------------------------------------------

	function show(next) {
		data = next;
		selectedPosition = undefined;
		selectedPeripheral = pendingPeripheral && data.peripherals && data.peripherals[pendingPeripheral] ? pendingPeripheral : undefined;
		pendingPeripheral = undefined;
		if (!data.error) {
			buildSearchText();
		}
		render();
	}

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (message.type === 'data') {
			show(message.data);
		} else if (message.type === 'select' && message.peripheral) {
			if (data && !data.error && data.peripherals[message.peripheral]) {
				selectedPeripheral = message.peripheral;
				restyle();
				drawSide();
			} else {
				pendingPeripheral = message.peripheral;
			}
		} else if (message.error !== undefined) {
			show({ error: message.error });
		}
	});
	let resizeTimer;
	window.addEventListener('resize', () => {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			if (data && !data.error && zoom === null) {
				drawPackage();
			}
		}, 120);
	});
	vscode.postMessage({ type: 'ready' });
})();
