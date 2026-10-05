// The pin layout webview: draws the package from the geometry the extension computed and shows
// the pin or peripheral that is clicked. Text is set with textContent only; the data comes from
// the CLI and from project files.
(function () {
	'use strict';
	const vscode = acquireVsCodeApi();
	const SVG = 'http://www.w3.org/2000/svg';
	const root = document.getElementById('app');
	let data;
	let selectedPosition;
	let highlightedPeripheral;
	let zoom = 1;

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

	function render() {
		root.replaceChildren();
		if (data.error) {
			root.append(el('p', 'error', data.error));
			return;
		}
		const header = el('header');
		header.append(el('h1', undefined, data.title), el('span', 'subtitle', data.subtitle));
		const tools = el('span', 'tools');
		for (const [label, delta] of [['−', 0.8], ['+', 1.25], ['1:1', 0]]) {
			const button = el('button', undefined, label);
			button.addEventListener('click', () => {
				zoom = delta === 0 ? 1 : Math.min(4, Math.max(0.3, zoom * delta));
				drawPackage();
			});
			tools.append(button);
		}
		header.append(tools);
		const main = el('div', 'main');
		const left = el('div', 'package');
		left.id = 'package';
		const right = el('aside');
		right.id = 'side';
		main.append(left, right);
		root.append(header, main);
		drawPackage();
		drawSide();
	}

	// The text of a pin on the drawing: ST names carry the function (PA13(JTMS/SWDIO),
	// PC13-ANTI_TAMP); the full name stays in the tooltip and the side panel.
	function shortLabel(text, max) {
		const base = text.replace(/\(.*$/, '');
		return base.length > max ? `${base.slice(0, max - 1)}…` : base;
	}

	function labelFor(cell) {
		const { x, y, width, height, side } = cell;
		const cx = x + width / 2;
		const cy = y + height / 2;
		switch (side) {
			case 'left':
				return svg('text', { x: x - 4, y: cy + 3, 'text-anchor': 'end', class: 'name' }, shortLabel(cell.label, 14));
			case 'right':
				return svg('text', { x: x + width + 4, y: cy + 3, class: 'name' }, shortLabel(cell.label, 14));
			case 'top':
				return svg('text', { transform: `translate(${cx + 3} ${y - 4}) rotate(-90)`, class: 'name' }, shortLabel(cell.label, 14));
			case 'bottom':
				return svg('text', { transform: `translate(${cx - 3} ${y + height + 4}) rotate(90)`, class: 'name' }, shortLabel(cell.label, 14));
			default:
				return svg('text', { x: cx, y: cy + 2.5, 'text-anchor': 'middle', class: 'ball' }, shortLabel(cell.label.split('-')[0], 5));
		}
	}

	function drawPackage() {
		const host = document.getElementById('package');
		host.replaceChildren();
		const g = data.geometry;
		const canvas = svg('svg', { viewBox: `0 0 ${g.width} ${g.height}`, width: g.width * zoom, height: g.height * zoom });
		canvas.append(svg('rect', { class: 'body', x: g.body.x, y: g.body.y, width: g.body.width, height: g.body.height, rx: 4 }));
		canvas.append(svg('text', { class: 'chip', x: g.body.x + g.body.width / 2, y: g.body.y + g.body.height / 2, 'text-anchor': 'middle' }, data.title));
		for (const cell of g.cells) {
			const group = svg('g', { class: `cell ${cell.className}` });
			if (cell.position === selectedPosition) {
				group.classList.add('selected');
			}
			if (highlightedPeripheral && cell.peripheral === highlightedPeripheral) {
				group.classList.add('highlight');
			}
			const names = cell.names.join(' / ');
			group.append(svg('title', {}, `${cell.position}: ${names}`));
			group.append(svg('rect', { x: cell.x, y: cell.y, width: cell.width, height: cell.height, rx: 1.5 }));
			group.append(labelFor(cell));
			group.addEventListener('click', () => {
				selectedPosition = cell.position;
				drawPackage();
				drawSide();
			});
			canvas.append(group);
		}
		host.append(canvas);
	}

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
			selected.append(el('strong', undefined, 'Selected: '), document.createTextNode(`${a.signal} → ${a.peripheral} ${a.function}`));
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
			const used = data.used.find((peripheral) => peripheral.name === a.peripheral);
			if (used && used.config) {
				box.append(paramsTable(used.config));
			}
		}
		const byPeripheral = new Map();
		for (const fn of entry.functions) {
			byPeripheral.set(fn.peripheral, [...(byPeripheral.get(fn.peripheral) || []), fn]);
		}
		if (byPeripheral.size > 0) {
			box.append(el('h4', undefined, 'Can be'));
			for (const [peripheral, functions] of byPeripheral) {
				const line = el('div', `fn cat-${functions[0].category}`);
				line.append(el('span', 'peripheral', peripheral));
				for (const fn of functions) {
					const mode = entry.modes && entry.modes[`${peripheral}.${fn.function}`];
					line.append(el('span', 'chip', mode === undefined ? fn.function : `${fn.function} (${mode})`));
				}
				box.append(line);
			}
		}
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
		} else {
			side.append(el('p', 'dim', 'Click a pin.'));
		}
		if (data.hasProject) {
			side.append(el('h2', undefined, 'Peripherals in the project'));
			for (const used of data.used) {
				const item = el('div', `used cat-${used.category}`);
				const title = el('div', 'title');
				title.append(el('strong', undefined, used.name));
				if (used.config) {
					title.append(el('span', used.config.present ? 'badge' : 'badge dim', used.config.present ? 'configured' : 'not configured'));
				}
				item.append(title, el('div', 'dim', used.pins.map((pin) => `${pin.function} ${pin.pin}`).join(' · ')));
				item.addEventListener('click', () => {
					highlightedPeripheral = highlightedPeripheral === used.name ? undefined : used.name;
					const first = used.pins.find((pin) => pin.position);
					if (first && highlightedPeripheral) {
						selectedPosition = first.position;
					}
					drawPackage();
					drawSide();
				});
				side.append(item);
			}
		}
		side.append(el('p', 'dim source', data.source));
	}

	window.addEventListener('message', (event) => {
		data = event.data;
		selectedPosition = undefined;
		highlightedPeripheral = undefined;
		render();
	});
	vscode.postMessage({ type: 'ready' });
})();
