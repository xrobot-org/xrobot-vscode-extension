// The pin layout webview: draws the package from the geometry the extension computed, zooms and
// pans it, searches and filters it, and shows the pin or the peripheral that is selected. Text is
// set with textContent only; the data comes from the CLI and from project files.
(function () {
	'use strict';
	const vscode = acquireVsCodeApi();
	const SVG = 'http://www.w3.org/2000/svg';
	const app = document.getElementById('app');

	// The legend entries that filter; power and special pins are drawn but not filtered.
	const LEGEND = [
		['comm', 'Communication'],
		['timer', 'Timer'],
		['analog', 'Analog'],
		['gpio', 'GPIO'],
		['system', 'System'],
		['memory', 'Memory'],
		['other', 'Other'],
		['free', 'Unused'],
	];
	const CATEGORIES = LEGEND.slice(0, 7);
	const CATEGORY_NAMES = Object.fromEntries(LEGEND);
	const NARROW = window.matchMedia('(max-width: 900px)');

	let data;
	let previous;
	let busy = false;
	// The part of the package that is shown (the SVG viewBox): null shows the whole package. The
	// wheel zooms around the pointer, a drag pans, a double click shows the whole package again.
	let box = null;
	let dragged = false;
	let query = '';
	let matchIndex = -1;
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

	// ---- state kept while the panel is hidden or the window reloads ----------------------------

	function persist() {
		if (!data || data.error) {
			return;
		}
		vscode.setState({
			title: data.title,
			subtitle: data.subtitle,
			query,
			showFunctions,
			filters: [...filters],
			box,
			selectedPosition,
			selectedPeripheral,
		});
	}

	function restore() {
		const saved = vscode.getState();
		if (!saved || saved.title !== data.title || saved.subtitle !== data.subtitle) {
			return;
		}
		query = saved.query || '';
		showFunctions = saved.showFunctions !== false;
		filters.clear();
		for (const key of saved.filters || []) {
			filters.add(key);
		}
		box = saved.box || null;
		selectedPosition = saved.selectedPosition && data.details[saved.selectedPosition] ? saved.selectedPosition : undefined;
		selectedPeripheral = saved.selectedPeripheral && data.peripherals[saved.selectedPeripheral] ? saved.selectedPeripheral : undefined;
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
					words.push(fn.peripheral + '.' + fn.function, fn.peripheral + '_' + fn.function, fn.peripheral);
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

	function matches() {
		return query.trim() ? data.geometry.cells.filter((cell) => matchesQuery(cell.position)) : [];
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

	// ---- page ---------------------------------------------------------------------------------

	function loading(text) {
		app.replaceChildren();
		const wrap = el('div', 'loading');
		wrap.append(el('span', 'spinner'), el('span', undefined, text));
		app.append(wrap);
	}

	function failure(message) {
		app.replaceChildren();
		const wrap = el('div', 'failure');
		wrap.append(el('h2', undefined, 'Cannot show the pin layout'), el('pre', undefined, message));
		const output = el('button', 'link', 'Show the XRobot output');
		output.addEventListener('click', () => vscode.postMessage({ type: 'showOutput' }));
		wrap.append(output);
		app.append(wrap);
	}

	function render() {
		app.replaceChildren();
		if (data.error) {
			failure(data.error);
			return;
		}
		app.append(toolbar());
		if (data.hasProject) {
			app.append(legend());
		}
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

	function zoomButton(text, title, handler) {
		const button = el('button', undefined, text);
		button.title = title;
		button.setAttribute('aria-label', title);
		button.addEventListener('click', handler);
		return button;
	}

	function toolbar() {
		const bar = el('div', 'bar');
		const top = el('header');
		top.append(el('h1', undefined, data.title), el('span', 'subtitle', data.subtitle));
		top.append(el('span', 'busy', busy ? 'updating…' : ''));
		const tools = el('span', 'tools');
		const zoom = el('span', 'zoom', zoomLabel());
		zoom.id = 'zoom';
		tools.append(
			zoomButton('−', 'Zoom out', () => zoomBy(1 / 1.4)),
			zoom,
			zoomButton('+', 'Zoom in', () => zoomBy(1.4)),
			zoomButton('Fit', 'Show the whole package (double click the drawing)', fit),
		);
		top.append(tools);
		bar.append(top);

		const second = el('div', 'searchrow');
		const search = el('input');
		search.type = 'search';
		search.placeholder = 'Search a pin, signal or peripheral';
		search.value = query;
		search.setAttribute('aria-label', 'Search pins');
		const count = el('span', 'dim count', matchCount());
		search.addEventListener('input', () => {
			query = search.value;
			matchIndex = -1;
			restyle();
			count.textContent = matchCount();
			persist();
		});
		// Enter goes to the next matching pin, Shift+Enter to the previous, Escape clears.
		search.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				const found = matches();
				if (found.length > 0) {
					matchIndex = (matchIndex + (event.shiftKey ? -1 : 1) + found.length) % found.length;
					const cell = found[matchIndex];
					selectPin(cell.position);
					panTo(cell.position);
					count.textContent = matchCount();
				}
				event.preventDefault();
			} else if (event.key === 'Escape') {
				search.value = '';
				query = '';
				matchIndex = -1;
				restyle();
				count.textContent = '';
				persist();
			}
		});
		second.append(search, count);
		if (data.hasProject) {
			const label = el('button', 'toggle' + (showFunctions ? ' on' : ''), 'Show functions');
			label.title = 'Label the selected pins with the function the project uses';
			label.setAttribute('aria-pressed', String(showFunctions));
			label.addEventListener('click', () => {
				showFunctions = !showFunctions;
				label.classList.toggle('on', showFunctions);
				label.setAttribute('aria-pressed', String(showFunctions));
				drawPackage();
				persist();
			});
			second.append(label);
		}
		bar.append(second);
		return bar;
	}

	function matchCount() {
		if (!query.trim()) {
			return '';
		}
		const n = matches().length;
		if (n === 0) {
			return 'no match';
		}
		return matchIndex >= 0 ? matchIndex + 1 + ' of ' + n : n + (n === 1 ? ' pin' : ' pins');
	}

	function legend() {
		const bar = el('div', 'legend');
		const present = new Set(data.geometry.cells.map((cell) => cell.legend));
		for (const [key, name] of LEGEND) {
			if (!present.has(key)) {
				continue;
			}
			const chip = el('button', 'chip cat-' + key + (filters.has(key) ? ' on' : ''), name);
			chip.title = 'Show only these pins';
			chip.setAttribute('aria-pressed', String(filters.has(key)));
			chip.addEventListener('click', () => {
				if (filters.has(key)) {
					filters.delete(key);
				} else {
					filters.add(key);
				}
				chip.classList.toggle('on');
				chip.setAttribute('aria-pressed', String(filters.has(key)));
				restyle();
				persist();
			});
			bar.append(chip);
		}
		return bar;
	}

	// ---- zoom and pan -------------------------------------------------------------------------

	function wholeBox() {
		return { x: 0, y: 0, w: data.geometry.width, h: data.geometry.height };
	}

	function shownBox() {
		return box || wholeBox();
	}

	function zoomLabel() {
		return Math.round((100 * wholeBox().w) / shownBox().w) + '%';
	}

	function applyBox() {
		const canvas = document.querySelector('#package svg');
		const shown = shownBox();
		canvas.setAttribute('viewBox', shown.x + ' ' + shown.y + ' ' + shown.w + ' ' + shown.h);
		const label = document.getElementById('zoom');
		if (label) {
			label.textContent = zoomLabel();
		}
		persist();
	}

	function fit() {
		box = null;
		applyBox();
	}

	function zoomBy(factor) {
		const shown = shownBox();
		zoomAt(factor, shown.x + shown.w / 2, shown.y + shown.h / 2);
	}

	// Zooms by factor around the point (cx, cy) of the drawing, which stays where it is on screen.
	function zoomAt(factor, cx, cy) {
		const whole = wholeBox();
		const shown = shownBox();
		const w = Math.min(whole.w, Math.max(whole.w / 14, shown.w / factor));
		if (w >= whole.w) {
			fit();
			return;
		}
		const scale = w / shown.w;
		box = { x: cx - (cx - shown.x) * scale, y: cy - (cy - shown.y) * scale, w, h: shown.h * scale };
		applyBox();
	}

	// Shows these cells (padded) as large as the window allows.
	function fitCells(cells) {
		if (cells.length === 0) {
			return;
		}
		const host = document.getElementById('package');
		const aspect = host.clientWidth / Math.max(1, host.clientHeight);
		const x0 = Math.min(...cells.map((cell) => cell.x));
		const y0 = Math.min(...cells.map((cell) => cell.y));
		const x1 = Math.max(...cells.map((cell) => cell.x + cell.width));
		const y1 = Math.max(...cells.map((cell) => cell.y + cell.height));
		let w = Math.max(x1 - x0 + 120, 220);
		let h = Math.max(y1 - y0 + 120, 220 / aspect);
		if (w / h < aspect) {
			w = h * aspect;
		} else {
			h = w / aspect;
		}
		if (w >= data.geometry.width * 0.85) {
			fit();
			return;
		}
		box = { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h };
		applyBox();
	}

	// Centres the view on a pin when the drawing is zoomed and the pin is out of sight.
	function panTo(position) {
		const cell = data.geometry.cells.find((candidate) => candidate.position === position);
		if (!cell || !box) {
			return;
		}
		const cx = cell.x + cell.width / 2;
		const cy = cell.y + cell.height / 2;
		const inside = cx > box.x + box.w * 0.08 && cx < box.x + box.w * 0.92 && cy > box.y + box.h * 0.08 && cy < box.y + box.h * 0.92;
		if (!inside) {
			box = { ...box, x: cx - box.w / 2, y: cy - box.h / 2 };
			applyBox();
		}
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
				// With the drawing above the inspector (a narrow window) the wheel scrolls the page;
				// Ctrl or Command (and a trackpad pinch) zooms.
				if (NARROW.matches && !event.ctrlKey && !event.metaKey) {
					return;
				}
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

	// ---- keyboard -----------------------------------------------------------------------------

	// The pin next to a cell in a direction: the nearest one that lies that way.
	function neighbour(from, dx, dy) {
		let best;
		let bestScore = Infinity;
		const fx = from.x + from.width / 2;
		const fy = from.y + from.height / 2;
		for (const cell of data.geometry.cells) {
			if (cell === from) {
				continue;
			}
			const ox = cell.x + cell.width / 2 - fx;
			const oy = cell.y + cell.height / 2 - fy;
			const along = ox * dx + oy * dy;
			const across = Math.abs(ox * dy + oy * dx);
			if (along <= 1) {
				continue;
			}
			const score = along + across * 2.5;
			if (score < bestScore) {
				best = cell;
				bestScore = score;
			}
		}
		return best;
	}

	// On a leaded package the arrow that points along the side the pin is on moves to the next or the
	// previous pin number (the side's own direction), carrying on round the corner; any other arrow
	// moves to the nearest pin that way.
	const ALONG = {
		left: { ArrowDown: 1, ArrowUp: -1 },
		bottom: { ArrowRight: 1, ArrowLeft: -1 },
		right: { ArrowUp: 1, ArrowDown: -1 },
		top: { ArrowLeft: 1, ArrowRight: -1 },
	};

	function ringNeighbour(from, key) {
		const step = ALONG[from.side] && ALONG[from.side][key];
		if (!step || data.geometry.shape === 'grid') {
			return undefined;
		}
		const ring = data.geometry.cells.filter((cell) => ALONG[cell.side]).sort((a, b) => Number(a.position) - Number(b.position));
		const index = ring.indexOf(from);
		return index < 0 ? undefined : ring[(index + step + ring.length) % ring.length];
	}

	function onKey(event) {
		const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
		if (event.key === 'Escape') {
			clearSelection();
			return;
		}
		if (!arrows[event.key]) {
			return;
		}
		event.preventDefault();
		const cells = data.geometry.cells;
		const current = cells.find((cell) => cell.position === selectedPosition) || cells[0];
		const next = selectedPosition ? ringNeighbour(current, event.key) || neighbour(current, arrows[event.key][0], arrows[event.key][1]) : current;
		if (next) {
			selectPin(next.position);
			panTo(next.position);
		}
	}

	// ---- package ------------------------------------------------------------------------------

	function shortLabel(text, max) {
		const base = text.replace(/\(.*$/, '');
		return base.length > max ? base.slice(0, max - 1) + '…' : base;
	}

	function cellText(cell) {
		if (showFunctions && cell.functionLabel) {
			return cell.label + ' ' + cell.functionLabel;
		}
		return cell.label;
	}

	function labelFor(cell) {
		const { x, y, width, height, side } = cell;
		const cx = x + width / 2;
		const cy = y + height / 2;
		const text = shortLabel(cellText(cell), 21);
		switch (side) {
			case 'left':
				return svg('text', { x: x - 4, y: cy + 3.4, 'text-anchor': 'end', class: 'name' }, text);
			case 'right':
				return svg('text', { x: x + width + 4, y: cy + 3.4, class: 'name' }, text);
			case 'top':
				return svg('text', { transform: 'translate(' + (cx + 3.4) + ' ' + (y - 4) + ') rotate(-90)', class: 'name' }, text);
			case 'bottom':
				return svg('text', { transform: 'translate(' + (cx - 3.4) + ' ' + (y + height + 4) + ') rotate(90)', class: 'name' }, text);
			default:
				return svg('text', { x: cx, y: cy + 2.8, 'text-anchor': 'middle', class: 'ball' }, shortLabel(cell.label.split('-')[0], 5));
		}
	}

	function cellDescription(cell) {
		return 'Pin ' + cell.position + ', ' + cell.names.join(' / ') + (cell.functionLabel ? ', ' + cell.functionLabel : '');
	}

	function drawPackage() {
		const host = document.getElementById('package');
		host.replaceChildren();
		const g = data.geometry;
		const shown = shownBox();
		const canvas = svg('svg', { viewBox: shown.x + ' ' + shown.y + ' ' + shown.w + ' ' + shown.h, width: '100%', height: '100%', tabindex: 0, role: 'application' });
		canvas.setAttribute('aria-label', 'Package ' + data.subtitle + '. Arrow keys move between pins, Escape clears the selection.');
		canvas.append(svg('rect', { class: 'body', x: g.body.x, y: g.body.y, width: g.body.width, height: g.body.height, rx: 4 }));
		canvas.append(svg('circle', { class: 'pin1', cx: g.marker.x, cy: g.marker.y, r: 3.4 }));
		canvas.append(svg('text', { class: 'chip', x: g.body.x + g.body.width / 2, y: g.body.y + g.body.height / 2, 'text-anchor': 'middle' }, data.title));
		for (const cell of g.cells) {
			const group = svg('g', { class: 'cell ' + cell.className, role: 'button' });
			group.setAttribute('aria-label', cellDescription(cell));
			group.dataset.position = cell.position;
			group.dataset.legend = cell.legend;
			group.append(svg('title', {}, cellDescription(cell)));
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
		canvas.addEventListener('keydown', onKey);
		enableZoomAndPan(canvas, host);
		host.append(canvas);
		restyle();
	}

	// Selection, search, filters and the candidates of a selected peripheral change classes only,
	// so the drawing is not rebuilt for them.
	function restyle() {
		const searching = query.trim().length > 0;
		const candidates = candidatePositions();
		const found = searching ? new Set(matches().map((cell) => cell.position)) : undefined;
		for (const group of document.querySelectorAll('#package .cell')) {
			const position = group.dataset.position;
			const hit = (!found || found.has(position)) && (filters.size === 0 || filters.has(group.dataset.legend));
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
		persist();
		announce(assigned && assigned.peripheral);
	}

	function selectPeripheral(name) {
		selectedPeripheral = name;
		selectedPosition = undefined;
		locatedPosition = undefined;
		restyle();
		drawSide();
		persist();
		announce(name);
	}

	function clearSelection() {
		selectedPosition = undefined;
		selectedPeripheral = undefined;
		locatedPosition = undefined;
		restyle();
		drawSide();
		persist();
	}

	// Brings a pin into view on the drawing and rings it, without changing the selection.
	function locate(position) {
		locatedPosition = position;
		panTo(position);
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
		const wrap = block('Settings', config.section + '.' + config.key);
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

	// The title of the inspector: what is selected, a short line about it, and the button that
	// clears the selection.
	function header(title, aside, withClear) {
		const head = el('div', 'inspector-head');
		head.append(el('h2', undefined, title));
		if (aside) {
			head.append(typeof aside === 'string' ? el('span', 'dim', aside) : aside);
		}
		if (withClear) {
			const clear = el('button', 'link clear', '×');
			clear.title = 'Clear the selection (Escape)';
			clear.setAttribute('aria-label', 'Clear the selection');
			clear.addEventListener('click', clearSelection);
			head.append(clear);
		}
		return head;
	}

	function pinView(detail) {
		const wrap = el('div');
		if (detail.entries.length > 1) {
			wrap.append(el('p', 'dim', 'Pin ' + detail.position + ' is shared by ' + detail.entries.length + ' pins.'));
		}
		detail.entries.forEach((entry, index) => {
			const section = el('section', 'entry');
			const facts = ['pin ' + detail.position, entry.type];
			if (entry.iomuxPincm !== undefined) {
				facts.push('PINCM' + entry.iomuxPincm);
			}
			section.append(header(entry.name, facts.join(' · '), index === 0));
			if (entry.gpioModes.length > 0) {
				section.append(el('div', 'dim', 'GPIO: ' + entry.gpioModes.join(', ')));
			}

			if (data.hasProject) {
				const used = block('Used by the project as');
				if (entry.assigned) {
					const a = entry.assigned;
					const line = el('div', 'usedas' + (a.matched ? '' : ' mismatch'));
					const name = el('button', 'peripheral-link', a.peripheral + ' · ' + a.function);
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
			for (const [category] of CATEGORIES) {
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
		});
		return wrap;
	}

	function peripheralView(name) {
		const peripheral = data.peripherals[name];
		const wrap = el('div');
		const badge = el('span', 'kind cat-' + peripheral.category, peripheral.kind);
		wrap.append(header(name, badge, true));
		if (peripheral.capabilities.length > 0) {
			wrap.append(el('div', 'dim', 'Can be used for: ' + peripheral.capabilities.join(', ')));
		}
		if (peripheral.config) {
			wrap.append(settings(peripheral.config));
		} else if (data.hasProject) {
			wrap.append(el('div', 'dim', peripheral.used ? 'libxr gen does not generate this peripheral.' : 'The project does not use it.'));
		}
		const pins = block('Pins', 'filled: used · outline: can be used · click one to find it');
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
			side.append(el('p', 'dim hint', 'Click a pin on the drawing, or choose a peripheral in the sidebar.'));
			side.append(el('p', 'dim hint', 'Scroll to zoom, drag to pan, double click to fit.'));
		}
		side.append(el('p', 'dim source', data.source));
	}

	// ---- messages -----------------------------------------------------------------------------

	function show(next) {
		data = next;
		busy = false;
		if (data.error) {
			render();
			return;
		}
		// The same chip keeps what was selected and zoomed; after a reload of the window the
		// saved state does.
		const sameChip = previous && previous.title === data.title && previous.subtitle === data.subtitle;
		const keepPin = sameChip ? selectedPosition : undefined;
		const keepPeripheral = sameChip ? selectedPeripheral : undefined;
		const keepBox = sameChip ? box : null;
		selectedPosition = undefined;
		selectedPeripheral = undefined;
		box = null;
		if (sameChip) {
			selectedPosition = keepPin && data.details[keepPin] ? keepPin : undefined;
			selectedPeripheral = keepPeripheral && data.peripherals[keepPeripheral] ? keepPeripheral : undefined;
			box = keepBox;
		} else {
			restore();
		}
		if (pendingPeripheral && data.peripherals[pendingPeripheral]) {
			selectedPeripheral = pendingPeripheral;
			selectedPosition = undefined;
		}
		locatedPosition = undefined;
		pendingPeripheral = undefined;
		buildSearchText();
		previous = { title: data.title, subtitle: data.subtitle };
		render();
	}

	// A peripheral chosen in the sidebar, which already shows it selected: not announced back. Its
	// pins are brought into view.
	function selectFromOutside(name) {
		selectedPeripheral = name;
		selectedPosition = undefined;
		locatedPosition = undefined;
		drawSide();
		const candidates = candidatePositions();
		fitCells(data.geometry.cells.filter((cell) => candidates.has(cell.position)));
		restyle();
		persist();
	}

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (message.type === 'data') {
			show(message.data);
		} else if (message.type === 'busy') {
			busy = true;
			const label = document.querySelector('.busy');
			if (label) {
				label.textContent = 'updating…';
			}
		} else if (message.type === 'select' && message.peripheral) {
			if (data && !data.error && data.peripherals[message.peripheral]) {
				selectFromOutside(message.peripheral);
			} else {
				pendingPeripheral = message.peripheral;
			}
		}
	});
	loading('Running libxr pins…');
	vscode.postMessage({ type: 'ready' });
})();
