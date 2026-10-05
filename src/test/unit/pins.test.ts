import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { libxrArgs } from '../../cli/xrobotCli';
import { packageGeometry, pinCount } from '../../pins/geometry';
import { categoryOf, parsePinsOutput, type PinsPin, type PinsResult } from '../../pins/model';
import { detectPinsProject, findTiHeader } from '../../pins/project';
import { buildView, usedPeripherals } from '../../pins/view';

// Real `libxr pins -d` output (CodeGenerator, `libxr pins` of dev), trimmed to nothing: an
// STM32F103C8T6 in a project with USART1, SPI1, an LED and a key, and the MSPM0G3507 template
// (LQFP-64) with UART0 and a GPIO group.
const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'unit', 'fixtures');

function fixture(name: string): PinsResult {
	const parsed = parsePinsOutput(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
	assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
	return parsed.result;
}

function pins(positions: string[], name = 'P'): PinsPin[] {
	return positions.map((position) => ({ position, name: `${name}${position}`, type: 'I/O', signals: [] }));
}

function cellAt(result: ReturnType<typeof packageGeometry>, position: string) {
	const cell = result.cells.find((candidate) => candidate.position === position);
	assert.ok(cell, `no cell at ${position}`);
	return cell;
}

suite('libxr pins output', () => {
	test('real output of an STM32 and an MSPM0 project parses', () => {
		const stm32 = fixture('pins-stm32f103c8.json');
		assert.deepStrictEqual([stm32.platform, stm32.package, stm32.pin_count], ['stm32', 'LQFP48', 48]);
		assert.strictEqual(stm32.project?.assignments.PA9.signal, 'USART1_TX');
		const mspm0 = fixture('pins-mspm0g3507.json');
		assert.deepStrictEqual([mspm0.platform, mspm0.part, mspm0.package], ['mspm0', 'MSPM0G3507', 'LQFP-64(PM)']);
		assert.strictEqual(mspm0.project?.assignments.PA0.signal, 'UART0.TX');
	});

	test('output that is not the expected JSON is an error, naming what is wrong', () => {
		const cases: [string, string][] = [
			['not json', 'libxr pins did not print JSON'],
			['[]', 'not an object'],
			['{"model":"X"}', 'has no "platform"'],
			['{"model":"X","platform":"p","part":"x","package":"y"}', 'no "pins" or "peripherals"'],
			['{"model":"X","platform":"p","part":"x","package":"y","peripherals":{},"pins":[{"position":1}]}', 'a pin without position, name or signals'],
			['{"model":"X","platform":"p","part":"x","package":"y","peripherals":{},"pins":[],"project":{}}', 'invalid "project"'],
		];
		for (const [text, message] of cases) {
			const parsed = parsePinsOutput(text);
			assert.ok(!parsed.ok, text);
			assert.ok(!parsed.ok && parsed.error.includes(message), `${text}: ${!parsed.ok ? parsed.error : ''}`);
		}
	});

	test('a byte order mark in front of the JSON is ignored', () => {
		const text = fs.readFileSync(path.join(FIXTURES, 'pins-stm32f103c8.json'), 'utf8');
		assert.ok(parsePinsOutput(`﻿${text}`).ok);
	});

	test('the arguments run libxr pins in the workspace root with the settings', () => {
		assert.deepStrictEqual(libxrArgs.pins('.', 'User/libxr_config.yaml'), [
			'pins', '-d', '.', '-c', 'User/libxr_config.yaml', '-f', 'json',
		]);
		assert.deepStrictEqual(libxrArgs.pins('.', 'c.yaml', 'LQFP-64'), [
			'pins', '-d', '.', '-c', 'c.yaml', '-f', 'json', '-p', 'LQFP-64',
		]);
	});

	test('peripherals LibXR has no object for still get a colour', () => {
		assert.strictEqual(categoryOf('USART'), 'comm');
		assert.strictEqual(categoryOf('TIMA'), 'timer');
		assert.strictEqual(categoryOf('OPA'), 'analog');
		assert.strictEqual(categoryOf('EXTI'), 'gpio');
		assert.strictEqual(categoryOf('OCTOSPIM'), 'memory');
		assert.strictEqual(categoryOf('SOMETHING_NEW'), 'other');
	});
});

suite('package geometry', () => {
	test('a quad package counts counter-clockwise from the top-left corner', () => {
		const geometry = packageGeometry('LQFP48', fixture('pins-stm32f103c8.json').pins);
		assert.strictEqual(geometry.shape, 'quad');
		assert.strictEqual(geometry.cells.length, 48);
		const sides = (from: number, to: number): Set<string> =>
			new Set(geometry.cells.filter((cell) => Number(cell.position) >= from && Number(cell.position) <= to).map((cell) => cell.side));
		assert.deepStrictEqual([sides(1, 12), sides(13, 24), sides(25, 36), sides(37, 48)].map((set) => [...set]), [
			['left'], ['bottom'], ['right'], ['top'],
		]);
		// Pin 1 is the highest on the left, pin 13 the leftmost at the bottom, pin 25 the lowest on
		// the right and pin 37 the rightmost at the top.
		assert.ok(cellAt(geometry, '1').y < cellAt(geometry, '12').y);
		assert.ok(cellAt(geometry, '13').x < cellAt(geometry, '24').x);
		assert.ok(cellAt(geometry, '25').y > cellAt(geometry, '36').y);
		assert.ok(cellAt(geometry, '37').x > cellAt(geometry, '48').x);
	});

	test('a 64-pin MSPM0 package puts pin 33 at the start of the right side', () => {
		const geometry = packageGeometry('LQFP-64(PM)', fixture('pins-mspm0g3507.json').pins);
		assert.strictEqual(geometry.shape, 'quad');
		assert.strictEqual(cellAt(geometry, '33').side, 'right');
		assert.deepStrictEqual(cellAt(geometry, '33').names, ['PA0']);
	});

	test('a dual package has the pins down the left and up the right', () => {
		const positions = Array.from({ length: 20 }, (_, i) => String(i + 1));
		const geometry = packageGeometry('VSSOP-20(DGS20)', pins(positions));
		assert.strictEqual(geometry.shape, 'dual');
		assert.deepStrictEqual([cellAt(geometry, '1').side, cellAt(geometry, '10').side], ['left', 'left']);
		assert.deepStrictEqual([cellAt(geometry, '11').side, cellAt(geometry, '20').side], ['right', 'right']);
		assert.ok(cellAt(geometry, '11').y > cellAt(geometry, '20').y);
		assert.strictEqual(cellAt(geometry, '1').y, cellAt(geometry, '20').y);
	});

	test('a pin count that is not a multiple of 4 cannot be a quad package', () => {
		const positions = Array.from({ length: 14 }, (_, i) => String(i + 1));
		assert.strictEqual(packageGeometry('PACKAGE14', pins(positions)).shape, 'dual');
	});

	test('an exposed pad after the last pin goes in the middle of the body', () => {
		const positions = Array.from({ length: 33 }, (_, i) => String(i + 1));
		const geometry = packageGeometry('VQFN-32(RHB)', pins(positions));
		assert.strictEqual(geometry.cells.length, 33);
		const pad = cellAt(geometry, '33');
		assert.strictEqual(pad.side, 'pad');
		assert.ok(pad.x > geometry.body.x && pad.x < geometry.body.x + geometry.body.width);
		assert.deepStrictEqual([pinCount(33, false), pinCount(48, false), pinCount(9, true), pinCount(62, false)], [32, 48, 8, 64]);
	});

	test('a ball grid is laid out by row letter and column number', () => {
		const geometry = packageGeometry('UFBGA', pins(['A1', 'A2', 'B1', 'B2', 'AA3']));
		assert.strictEqual(geometry.shape, 'grid');
		assert.ok(cellAt(geometry, 'A2').x > cellAt(geometry, 'A1').x);
		assert.ok(cellAt(geometry, 'B1').y > cellAt(geometry, 'A1').y);
		// AA sorts after Z-less single letters (A..Z, then AA..).
		assert.ok(cellAt(geometry, 'AA3').y > cellAt(geometry, 'B2').y);
	});

	test('positions that are not balls go below a ball grid', () => {
		const geometry = packageGeometry('WLCSP', pins(['A1', 'A2', 'B1', 'B2', '7']));
		const odd = cellAt(geometry, '7');
		assert.strictEqual(odd.side, 'extra');
		assert.ok(odd.y > cellAt(geometry, 'B2').y);
	});

	test('a layered ball such as 1A2 gets its own rows', () => {
		const geometry = packageGeometry('TFBGA361', pins(['A1', '1A2', '1A3', 'B1']));
		assert.strictEqual(geometry.shape, 'grid');
		assert.strictEqual(geometry.cells.length, 4);
		assert.notStrictEqual(cellAt(geometry, '1A2').y, cellAt(geometry, 'A1').y);
	});

	test('two pins at one position are one cell', () => {
		const remapped: PinsPin[] = [
			{ position: '1', name: 'PA11 [PA9]', type: 'I/O', signals: [] },
			{ position: '1', name: 'PA9 [PA11]', type: 'I/O', signals: [] },
			{ position: '2', name: 'PA1', type: 'I/O', signals: [] },
			{ position: '3', name: 'PA2', type: 'I/O', signals: [] },
			{ position: '4', name: 'PA3', type: 'I/O', signals: [] },
		];
		const geometry = packageGeometry('LQFP4', remapped);
		assert.strictEqual(geometry.cells.length, 4);
		assert.deepStrictEqual(cellAt(geometry, '1').names, ['PA11 [PA9]', 'PA9 [PA11]']);
	});
});

suite('pin layout view', () => {
	const view = buildView(fixture('pins-stm32f103c8.json'));
	const cell = (position: string) => {
		const found = view.geometry.cells.find((candidate) => candidate.position === position);
		assert.ok(found, position);
		return found;
	};

	test('the title and subtitle name the chip, the platform, the package and the pins', () => {
		assert.strictEqual(view.title, 'STM32F103C8Tx');
		assert.strictEqual(view.subtitle, 'STM32 · LQFP48 · 48 pins');
		assert.strictEqual(view.hasProject, true);
	});

	test('selected pins are coloured by the category of their peripheral', () => {
		// The pin names of the fixture: PA9 is USART1_TX, PA5 SPI1_SCK, PB12 a GPXTI line.
		// ST adds the function to some names (PA0-WKUP).
		const ofName = (name: string) =>
			view.geometry.cells.find((candidate) => candidate.names.some((n) => n === name || n.startsWith(`${name}-`)));
		assert.strictEqual(ofName('PA9')?.className, 'assigned cat-comm');
		assert.strictEqual(ofName('PA5')?.className, 'assigned cat-comm');
		assert.strictEqual(ofName('PB12')?.className, 'assigned cat-gpio');
		assert.strictEqual(ofName('PA9')?.peripheral, 'USART1');
		assert.strictEqual(ofName('PA0')?.className, 'free');
	});

	test('a GPIO keeps its pin name and is followed by the label the project gave it', () => {
		const led = view.geometry.cells.find((candidate) => candidate.names.some((name) => name.startsWith('PC13')));
		assert.strictEqual(led?.label, 'PC13-TAMPER-RTC');
		assert.strictEqual(led?.functionLabel, 'LED');
	});

	test('power pins are marked', () => {
		const power = view.geometry.cells.filter((candidate) => candidate.className === 'power');
		assert.ok(power.length >= 4, 'VDD and VSS pins');
	});

	test('the peripherals LibXR generates come first, with their settings', () => {
		const used = usedPeripherals(fixture('pins-stm32f103c8.json'));
		assert.strictEqual(used[0].name, 'USART1');
		assert.deepStrictEqual(used[0].config?.params, {
			tx_buffer_size: 128,
			rx_buffer_size: 128,
			tx_queue_size: 5,
			dma_section: '',
		});
		const names = used.map((peripheral) => peripheral.name);
		assert.strictEqual(used.find((peripheral) => peripheral.name === 'SPI1')?.config?.present, false);
		assert.strictEqual(used.find((peripheral) => peripheral.name === 'GPIOC')?.config, undefined);
		// configured, then generated but not configured, then the rest.
		assert.ok(names.indexOf('USART1') < names.indexOf('SPI1') && names.indexOf('SPI1') < names.indexOf('GPIOC'));
	});

	test('a selected pin shows what it does, a free one nothing', () => {
		const ofName = (name: string) => view.geometry.cells.find((candidate) => candidate.names.includes(name));
		assert.strictEqual(ofName('PA9')?.functionLabel, 'USART1.TX');
		assert.strictEqual(ofName('PA9')?.legend, 'comm');
		// A GPIO or an external interrupt is followed by its label, not by GPIOC.P13 or EXTI.LINE12.
		assert.strictEqual(ofName('PB12')?.functionLabel, 'KEY');
		assert.strictEqual(ofName('PB12')?.peripheral, 'EXTI');
		const free = view.geometry.cells.find((candidate) => candidate.legend === 'free');
		assert.strictEqual(free?.functionLabel, undefined);
		assert.deepStrictEqual(
			[...new Set(view.geometry.cells.map((candidate) => candidate.legend))].sort(),
			['comm', 'free', 'gpio', 'power', 'special'].filter((legend) => view.geometry.cells.some((candidate) => candidate.legend === legend)),
		);
	});

	test('a peripheral lists every pin that can carry each function, and the one in use', () => {
		const usart1 = view.peripherals.USART1;
		assert.strictEqual(usart1.category, 'comm');
		assert.strictEqual(usart1.used, true);
		const tx = usart1.functions.find((fn) => fn.function === 'TX');
		assert.deepStrictEqual(tx?.pins.slice().sort(), ['PA9', 'PB6']);
		assert.strictEqual(tx?.current, 'PA9');
		assert.strictEqual(usart1.config?.key, 'usart1');
		assert.strictEqual(view.peripherals.TIM3.used, false);
		assert.ok(view.peripherals.TIM3.capabilities.includes('pwm'));
	});

	test('a pin name finds its position', () => {
		assert.strictEqual(view.positions.PA9, view.details[view.positions.PA9].position);
		assert.ok(view.details[view.positions.PA9].entries.some((entry) => entry.name === 'PA9'));
	});

	test('the pin 1 mark is at the corner by pin 1 in every shape', () => {
		const quad = packageGeometry('LQFP48', fixture('pins-stm32f103c8.json').pins);
		const first = cellAt(quad, '1');
		const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
		for (const other of ['13', '25', '37']) {
			assert.ok(distance(quad.marker, first) < distance(quad.marker, cellAt(quad, other)), other);
		}
		const grid = packageGeometry('UFBGA', pins(['A1', 'A2', 'B1', 'B2']));
		assert.ok(distance(grid.marker, cellAt(grid, 'A1')) < distance(grid.marker, cellAt(grid, 'B2')));
	});

	test('a pin lists the functions it can carry, from the CLI recognition', () => {
		const detail = Object.values(view.details).find((candidate) => candidate.entries.some((entry) => entry.name === 'PA9'));
		const entry = detail?.entries.find((candidate) => candidate.name === 'PA9');
		assert.ok(entry?.functions.some((fn) => fn.peripheral === 'USART1' && fn.function === 'TX' && fn.category === 'comm'));
		assert.ok(entry?.functions.some((fn) => fn.peripheral === 'TIM1' && fn.function === 'CH2'));
		assert.deepStrictEqual(entry?.assigned?.peripheral, 'USART1');
	});

	test('an MSPM0 pin carries its IOMUX register and the mode of each signal', () => {
		const mspm0 = buildView(fixture('pins-mspm0g3507.json'));
		assert.strictEqual(mspm0.subtitle, 'MSPM0 · LQFP-64(PM) · 64 pins');
		const entry = mspm0.details['33'].entries[0];
		assert.strictEqual(entry.name, 'PA0');
		assert.strictEqual(entry.iomuxPincm, 1);
		assert.strictEqual(entry.modes?.['UART0.TX'], 2);
		assert.strictEqual(entry.assigned?.signal, 'UART0.TX');
		assert.strictEqual(usedPeripherals(fixture('pins-mspm0g3507.json')).find((used) => used.name === 'UART0')?.config, undefined);
	});

	test('an MSPM0 peripheral carries the settings of its SysConfig project, read-only', () => {
		const result = fixture('pins-mspm0g3507.json');
		const mspm0 = buildView(result);
		assert.strictEqual(mspm0.platform, 'mspm0');
		assert.strictEqual(mspm0.sysconfigFile, 'sysconfig/untitled.syscfg');
		const uart = mspm0.peripherals.UART0;
		assert.deepStrictEqual(uart.sysconfig, {
			module: 'UART',
			name: 'UART_0',
			params: { enabledInterrupts: ['RX', 'TX'], targetBaudRate: 2000000 },
		});
		// No libxr_config.yaml for an MSPM0, and a GPIO has no SysConfig settings of its own.
		assert.strictEqual(uart.config, undefined);
		assert.strictEqual(mspm0.peripherals.GPIOB.sysconfig, undefined);
		const used = usedPeripherals(result).find((peripheral) => peripheral.name === 'UART0');
		assert.strictEqual(used?.sysconfig?.params.targetBaudRate, 2000000);
	});

	test('an STM32 has no SysConfig file and its settings stay in libxr_config.yaml', () => {
		assert.strictEqual(view.platform, 'stm32');
		assert.strictEqual(view.sysconfigFile, null);
		assert.strictEqual(view.peripherals.USART1.sysconfig, undefined);
		assert.strictEqual(view.peripherals.USART1.config?.present, true);
	});

	test('a layout without a project has nothing selected', () => {
		const result = fixture('pins-stm32f103c8.json');
		delete result.project;
		const plain = buildView(result);
		assert.strictEqual(plain.hasProject, false);
		assert.strictEqual(usedPeripherals(result).length, 0);
		assert.strictEqual(Object.values(plain.peripherals).filter((peripheral) => peripheral.used).length, 0);
		assert.ok(plain.geometry.cells.every((candidate) => !candidate.className.startsWith('assigned')));
		assert.strictEqual(cell('1').className === 'assigned', false);
	});
});

suite('pin layout project detection', () => {
	function project(files: string[]): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xrobot-pins-'));
		for (const file of files) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), '');
		}
		return root;
	}

	test('an .ioc makes an STM32 project, ahead of a SysConfig header', () => {
		const root = project(['a.ioc', 'sysconfig/ti_msp_dl_config.h']);
		assert.deepStrictEqual(detectPinsProject(root, ['a.ioc']), { platform: 'stm32', source: 'a.ioc' });
	});

	test('the SysConfig header makes an MSPM0 project', () => {
		for (const header of ['ti_msp_dl_config.h', 'sysconfig/ti_msp_dl_config.h', 'a/b/ti_msp_dl_config.h', 'a/b/c/ti_msp_dl_config.h']) {
			const root = project([header]);
			assert.deepStrictEqual(detectPinsProject(root, []), { platform: 'mspm0', source: header }, header);
		}
	});

	test('a header too deep or inside a build folder does not count', () => {
		assert.strictEqual(findTiHeader(project(['a/b/c/d/ti_msp_dl_config.h'])), undefined);
		assert.strictEqual(findTiHeader(project(['build/x/ti_msp_dl_config.h'])), undefined);
		assert.strictEqual(findTiHeader(project(['cmake-build/x/y/ti_msp_dl_config.h'])), undefined);
		assert.strictEqual(detectPinsProject(project(['readme.md']), []), undefined);
	});
});
