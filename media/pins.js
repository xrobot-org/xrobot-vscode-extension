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
	// The part of the package that is shown (the SVG viewBox): null fits the whole package. The
	// wheel zooms around the pointer, a drag pans, a double click fits again.
	let box = null;
	let dragged = false;
	let query = '';
	let showFunctions = true;
	const filters = new Set();
	let selectedPosition;
	let selectedPeripheral;
	// A pin the user asked to find (from a peripheral's pin list); the selection does not change.
	let locatedPosition;
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
		for (const [text, factor, title] of [['−', 1 / 1.4, 'Zoom out'], ['+', 1.4, 'Zoom in'], ['Fit', 0, 'Fit to the window (double click)']]) {
			const button = el('button', undefined, text);
			button.title = title;
			button.addEventListener('click', () => {
				if (factor === 0) {
					fit();
				} else {
					const current = shownBox();
					zoomAt(factor, current.x + current.w / 2, current.y + current.h / 2);
				}
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

	// ---- zoom and pan -------------------------------------------------------------------------

	function wholeBox() {
		return { x: 0, y: 0, w: data.geometry.width, h: data.geometry.height };
	}

	function shownBox() {
		return box || wholeBox();
	}

	function applyBox() {
		const canvas = document.querySelector('#package svg');
		const shown = shownBox();
		canvas.setAttribute('viewBox', `${shown.x} ${shown.y} ${shown.w} ${shown.h}`);
	}

	function fit() {
		box = null;
		applyBox();
	}

	// Zooms by factor around the point (cx, cy) of the drawing, which stays where it is on screen.
	function zoomAt(factor, cx, cy) {
		const whole = wholeBox();
		const shown = shownBox();
		const w = Math.min(whole.w * 1.2, Math.max(whole.w / 14, shown.w / factor));
		const scale = w / shown.w;
		box = { x: cx - (cx - shown.x) * scale, y: cy - (cy - shown.y) * scale, w, h: shown.h * scale };
		applyBox();
	}

	// The point of the drawing under a mouse event.
	function drawingPoint(canvas, event) {
		const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(canvas.getScreenCTM().inverse());
		return { x: point.x, y: point.y };
	}

	function enableZoomAndPan(canvas, host) {
		canvas.addEventListener(
			'wheel',
			(event) => {
				event.preventDefault();
				const at = drawingPoint(canvas, event);
				zoomAt(event.deltaY < 0 ? 1.18 : 1 / 1.18, at.x, at.y);
			},
			{ passive: false },
		);
		canvas.addEventListener('dblclick', fit);
		canvas.addEventListener('pointerdown', (event) => {
			if (event.button !== 0) {
				return;
			}
			const start = { x: event.clientX, y: event.clientY, box: { ...shownBox() } };
			const unit = 1 / canvas.getScreenCTM().a;
			dragged = false;
			const move = (next) => {
				const dx = next.clientX - start.x;
				const dy = next.clientY - start.y;
				if (!dragged && Math.hypot(dx, dy) < 4) {
					return;
				}
				dragged = true;
				host.classList.add('dragging');
				box = { ...start.box, x: start.box.x - dx * unit, y: start.box.y - dy * unit };
				applyBox();
			};
			const stop = () => {
				window.removeEventListener('pointermove', move);
				window.removeEventListener('pointerup', stop);
				host.classList.remove('dragging');
			};
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', stop);
		});
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
		const shown = shownBox();
		const canvas = svg('svg', { viewBox: `${shown.x} ${shown.y} ${shown.w} ${shown.h}`, width: '100%', height: '100%' });
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
				// A drag that ends on a pin is not a click on it.
				if (dragged) {
					dragged = false;
					return;
				}
				selectPin(cell.position);
			});
			canvas.append(group);
		}
		enableZoomAndPan(canvas, host);
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
			group.classList.toggle('located', position === locatedPosition);
			group.classList.toggle('candidate', mark === 'candidate');
			group.classList.toggle('current', mark === 'current');
			group.classList.toggle('match', searching && hit);
		}
	}

	// ---- selection ----------------------------------------------------------------------------
	//
	// One thing is selected at a time: a pin (clicked on the drawing) or a peripheral (chosen in the
	// sidebar or by a peripheral name here). The inspector shows that one thing; the drawing
	// highlights it; the sidebar follows (the extension is told which peripheral is involved).

	function announce(peripheral) {
		vscode.postMessage({ type: 'selection', peripheral: peripheral || null });
	}

	function selectPin(position) {
		selectedPosition = position;
		selectedPeripheral = undefined;
		locatedPosition = undefined;
		const detail = data.details[position];
		const assigned = detail && detail.entries.map((entry) => entry.assigned).find(Boolean);
		restyle();
		drawSide();
		announce(assigned && assigned.peripheral);
	}

	function selectPeripheral(name) {
		selectedPeripheral = name;
		selectedPosition = undefined;
		locatedPosition = undefined;
		restyle();
		drawSide();
		announce(name);
	}

	function clearSelection() {
		selectedPosition = undefined;
		selectedPeripheral = undefined;
		locatedPosition = undefined;
		restyle();
		drawSide();
	}

	// Brings a pin into view on the drawing and rings it, without changing the selection.
	function locate(position) {
		locatedPosition = position;
		const cell = data.geometry.cells.find((candidate) => candidate.position === position);
		if (cell && box) {
			box = { ...box, x: cell.x + cell.width / 2 - box.w / 2, y: cell.y + cell.height / 2 - box.h / 2 };
			applyBox();
		}
		restyle();
	}

	// ---- inspector ----------------------------------------------------------------------------

	function row(label, value) {
		const line = el('div', 'row');
		line.append(el('span', 'k', label), el('span', 'v', value));
		return line;
	}

	function block(title, hint) {
		const wrap = el('div', 'block');
		const heading = el('h4', undefined, title);
		if (hint) {
			heading.append(el('span', 'hint', ' ' + hint));
		}
		wrap.append(heading);
		return wrap;
	}

	// The settings of a peripheral in libxr_config.yaml.
	function settings(config) {
		const wrap = block('Settings', config.section + '.' + config.key + ' in libxr_config.yaml');
		if (!config.present) {
			wrap.append(el('div', 'dim', 'Not in libxr_config.yaml yet.'));
		} else {
			for (const [name, value] of Object.entries(config.params || {})) {
				wrap.append(row(name, typeof value === 'object' ? JSON.stringify(value) : String(value)));
			}
		}
		if (data.configFile) {
			const open = el('button', 'link', 'Open libxr_config.yaml');
			open.addEventListener('click', () => vscode.postMessage({ type: 'openConfig' }));
			wrap.append(open);
		}
		return wrap;
	}

	function header(title, badge) {
		const head = el('div', 'inspector-head');
		head.append(el('h2', undefined, title));
		if (badge) {
			head.append(badge);
		}
		const clear = el('button', 'link', '\u00d7');
		clear.title = 'Clear the selection';
		clear.addEventListener('click', clearSelection);
		head.append(clear);
		return head;
	}

	function pinView(detail) {
		const wrap = el('div');
		wrap.append(header('Pin ' + detail.position));
		for (const entry of detail.entries) {
			const section = el('section', 'entry');
			section.append(el('h3', undefined, entry.name));
			const facts = [entry.type];
			if (entry.gpioModes.length > 0) {
				facts.push('GPIO: ' + entry.gpioModes.join(', '));
			}
			if (entry.iomuxPincm !== undefined) {
				facts.push('IOMUX PINCM' + entry.iomuxPincm);
			}
			section.append(el('div', 'dim', facts.join(' \u00b7 ')));

			if (data.hasProject) {
				const used = block('Used by the project as');
				if (entry.assigned) {
					const a = entry.assigned;
					const line = el('div', 'usedas' + (a.matched ? '' : ' mismatch'));
					const name = el('button', 'peripheral-link', a.peripheral + ' \u00b7 ' + a.function);
					name.title = 'Show ' + a.peripheral + ': its settings and every pin it can use';
					name.addEventListener('click', () => selectPeripheral(a.peripheral));
					line.append(name, el('span', 'dim', ' (' + a.signal + ')'));
					used.append(line);
					if (a.label) {
						used.append(el('div', 'dim', 'GPIO label: ' + a.label));
					}
					if (!a.matched) {
						used.append(el('div', 'dim', 'This is not a signal of this pin.'));
					}
					if (a.candidates) {
						used.append(el('div', 'dim', 'Could be ' + a.candidates.join(' or ') + '.'));
					}
				} else {
					used.append(el('div', 'dim', 'Nothing: the project does not use this pin.'));
				}
				section.append(used);
			}

			const can = block('This pin can be', 'click one to see that peripheral');
			const groups = new Map();
			for (const fn of entry.functions) {
				groups.set(fn.category, (groups.get(fn.category) || []).concat([fn]));
			}
			for (const [category] of LEGEND) {
				const functions = groups.get(category);
				if (!functions) {
					continue;
				}
				const line = el('div', 'can cat-' + category);
				line.append(el('span', 'cat', CATEGORY_NAMES[category]));
				const chips = el('span', 'chips');
				for (const fn of functions) {
					const mode = entry.modes && entry.modes[fn.peripheral + '.' + fn.function];
					const chip = el('button', 'chip-fn', fn.peripheral + ' ' + fn.function + (mode === undefined ? '' : ' (' + mode + ')'));
					chip.title = 'Show ' + fn.peripheral;
					chip.addEventListener('click', () => selectPeripheral(fn.peripheral));
					chips.append(chip);
				}
				line.append(chips);
				can.append(line);
			}
			if (entry.functions.length === 0) {
				can.append(el('div', 'dim', 'No peripheral function.'));
			}
			section.append(can);
			wrap.append(section);
		}
		return wrap;
	}

	function peripheralView(name) {
		const peripheral = data.peripherals[name];
		const wrap = el('div');
		wrap.append(header(name, el('span', 'kind cat-' + peripheral.category, peripheral.kind)));
		if (peripheral.capabilities.length > 0) {
			wrap.append(el('div', 'dim', 'Can be used for: ' + peripheral.capabilities.join(', ')));
		}
		if (peripheral.config) {
			wrap.append(settings(peripheral.config));
		} else if (data.hasProject) {
			wrap.append(el('div', 'dim', peripheral.used ? 'libxr gen does not generate this peripheral.' : 'The project does not use it.'));
		}
		const pins = block('Pins', 'filled: used by the project \u00b7 outline: can also be used \u00b7 click one to find it');
		for (const fn of peripheral.functions) {
			const line = el('div', 'function');
			line.append(el('span', 'fname', fn.function));
			const chips = el('span', 'fpins');
			for (const pin of fn.pins) {
				const chip = el('button', 'pinchip' + (fn.current === pin ? ' current' : ''), pin.replace(/\(.*$/, ''));
				chip.title = 'Pin ' + data.positions[pin] + ': ' + pin;
				chip.addEventListener('click', () => locate(data.positions[pin]));
				chips.append(chip);
			}
			line.append(chips);
			pins.append(line);
		}
		wrap.append(pins);
		return wrap;
	}

	function drawSide() {
		const side = document.getElementById('side');
		side.replaceChildren();
		if (selectedPeripheral && data.peripherals[selectedPeripheral]) {
			side.append(peripheralView(selectedPeripheral));
		} else if (selectedPosition && data.details[selectedPosition]) {
			side.append(pinView(data.details[selectedPosition]));
		} else {
			side.append(el('p', 'dim', 'Click a pin on the drawing, or choose a peripheral in the sidebar.'));
		}
		side.append(el('p', 'dim source', data.source));
	}

	// ---- messages -----------------------------------------------------------------------------

	function show(next) {
		// A refresh of the same chip keeps what is selected.
		const sameChip = data && !data.error && next && !next.error && data.title === next.title && data.subtitle === next.subtitle;
		const keepPin = sameChip ? selectedPosition : undefined;
		const keepPeripheral = sameChip ? selectedPeripheral : undefined;
		data = next;
		selectedPosition = keepPin && data.details && data.details[keepPin] ? keepPin : undefined;
		selectedPeripheral = keepPeripheral && data.peripherals && data.peripherals[keepPeripheral] ? keepPeripheral : undefined;
		if (pendingPeripheral && data.peripherals && data.peripherals[pendingPeripheral]) {
			selectedPeripheral = pendingPeripheral;
			selectedPosition = undefined;
		}
		locatedPosition = undefined;
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
				// From the sidebar, which already shows it selected: not announced back.
				selectedPeripheral = message.peripheral;
				selectedPosition = undefined;
				locatedPosition = undefined;
				restyle();
				drawSide();
			} else {
				pendingPeripheral = message.peripheral;
			}
		} else if (message.error !== undefined) {
			show({ error: message.error });
		}
	});
	vscode.postMessage({ type: 'ready' });
})();
