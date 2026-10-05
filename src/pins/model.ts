// The result of `libxr pins -d <project> -f json` (CodeGenerator): the package and pin layout of
// the project's chip, with the signals the project has selected. Pure; no `vscode` import.

export type PinsAssignment = {
	signal: string;
	peripheral: string;
	kind: string;
	function: string;
	// False when the signal is not among the signals of its pin.
	matched: boolean;
	label?: string;
	// An ADC channel that several ADCs can carry and the project does not decide.
	candidates?: string[];
};

export type PinsConfig = {
	// Section and key in libxr_config.yaml, such as USART and usart1.
	section: string;
	key: string;
	present: boolean;
	params?: Record<string, unknown>;
};

// The settings of an MSPM0 peripheral in the SysConfig project (the .syscfg), read-only.
export type PinsSysconfig = {
	// The SysConfig module (UART, SPI, ...) and the name given to the instance (UART_0).
	module: string;
	name: string | null;
	params: Record<string, unknown>;
};

export type PinsPin = {
	position: string;
	name: string;
	type: string;
	signals: string[];
	// STM32: Input, Output, Analog, EVENTOUT, EXTI.
	gpio_modes?: string[];
	// MSPM0: the IOMUX register of the pin and the mode of each signal.
	iomux_pincm?: number | null;
	modes?: Record<string, number | string>;
};

export type PinsPeripheral = {
	kind: string;
	// Function -> the pins that can carry it.
	signals: Record<string, string[]>;
	capabilities?: string[];
};

export type PinsUsed = {
	kind: string;
	// Function -> the pin it uses in the project.
	pins: Record<string, string>;
	config?: PinsConfig;
	sysconfig?: PinsSysconfig;
};

export type PinsProject = {
	directory: string;
	source: string;
	libxr_config: string | null;
	// The .syscfg the settings were read from, relative to the project (an MSPM0).
	sysconfig_file?: string | null;
	assignments: Record<string, PinsAssignment>;
	peripherals: Record<string, PinsUsed>;
};

export type PinsResult = {
	model: string;
	platform: string;
	part: string;
	package: string;
	// The number of positions on the package; a position can hold several pins (STM32G0 remap).
	pin_count: number;
	source: Record<string, string>;
	peripherals: Record<string, PinsPeripheral>;
	pins: PinsPin[];
	project?: PinsProject;
};

export type PinsParse = { ok: true; result: PinsResult } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Checks what the view relies on, not every field: the output is the CodeGenerator's, whose
// schema may grow.
export function parsePinsOutput(text: string): PinsParse {
	let value: unknown;
	try {
		value = JSON.parse(text.replace(/^﻿/, ''));
	} catch (error) {
		return { ok: false, error: `libxr pins did not print JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!isRecord(value)) {
		return { ok: false, error: 'libxr pins printed JSON that is not an object' };
	}
	for (const field of ['model', 'platform', 'part', 'package'] as const) {
		if (typeof value[field] !== 'string') {
			return { ok: false, error: `libxr pins output has no "${field}"` };
		}
	}
	if (!Array.isArray(value.pins) || !isRecord(value.peripherals)) {
		return { ok: false, error: 'libxr pins output has no "pins" or "peripherals"' };
	}
	for (const pin of value.pins) {
		if (!isRecord(pin) || typeof pin.position !== 'string' || typeof pin.name !== 'string' || !Array.isArray(pin.signals)) {
			return { ok: false, error: 'libxr pins output has a pin without position, name or signals' };
		}
	}
	if (value.project !== undefined && (!isRecord(value.project) || !isRecord(value.project.assignments) || !isRecord(value.project.peripherals))) {
		return { ok: false, error: 'libxr pins output has an invalid "project"' };
	}
	return { ok: true, result: value as unknown as PinsResult };
}

// What a failed `libxr pins` run says when the installed libxr is too old to have the command
// (5.x has no `python -m libxr`; 6.0.x has no `pins`): the CLI's own message is an ImportError or
// an argparse usage line, which does not tell the user what to do.
export function pinsFailureHint(message: string): string {
	if (/No module named libxr\.__main__|invalid choice.*'pins'/i.test(message)) {
		return `${message}
The libxr that was found is too old for the pin layout: it needs a release that has the "libxr pins" command. Update it (pip install -U libxr) or point xrobot.cli.extraPath / xrobot.cli.pythonPath at one that has it.`;
	}
	return message;
}

// The platform tag shown in the views.
export function platformLabel(platform: string): string {
	switch (platform) {
		case 'stm32':
			return 'STM32';
		case 'mspm0':
			return 'MSPM0';
		default:
			return platform;
	}
}

// Kinds of peripherals grouped for colouring; any kind not listed is "other", so a peripheral
// LibXR has no abstraction for still gets a colour.
export type Category = 'comm' | 'timer' | 'analog' | 'gpio' | 'system' | 'memory' | 'other';

const CATEGORY_OF: Record<string, Category> = {
	USART: 'comm', UART: 'comm', LPUART: 'comm', SPI: 'comm', I2C: 'comm', I2S: 'comm', I3C: 'comm',
	CAN: 'comm', FDCAN: 'comm', CANFD: 'comm', USB: 'comm', USB_OTG: 'comm', USB_DRD: 'comm', USBFS: 'comm',
	ETH: 'comm', UCPD: 'comm', SDMMC: 'comm', SDIO: 'comm', SAI: 'comm', SPDIFRX: 'comm', CEC: 'comm',
	TIM: 'timer', LPTIM: 'timer', HRTIM: 'timer', TIMA: 'timer', TIMG: 'timer', TIMX: 'timer',
	ADC: 'analog', DAC: 'analog', COMP: 'analog', OPAMP: 'analog', OPA: 'analog', GPAMP: 'analog',
	VREF: 'analog', VREFBUF: 'analog', ANALOG: 'analog', DFSDM: 'analog', SDADC: 'analog',
	GPIO: 'gpio', EXTI: 'gpio',
	RCC: 'system', SYS: 'system', DEBUG: 'system', DEBUGSS: 'system', SYSCTL: 'system', PWR: 'system',
	RTC: 'system', TAMP: 'system', BOOT: 'system',
	FMC: 'memory', FSMC: 'memory', QUADSPI: 'memory', OCTOSPI: 'memory', OCTOSPIM: 'memory',
	XSPI: 'memory', HSPI: 'memory',
};

export function categoryOf(kind: string): Category {
	return CATEGORY_OF[kind] ?? 'other';
}

// XRobot Style has four data colours (channels): communication, timer, analog and GPIO. Every other
// category is drawn as "other", without a colour.
export type Channel = 'comm' | 'timer' | 'analog' | 'gpio' | 'other';

export function channelOf(category: Category): Channel {
	return category === 'comm' || category === 'timer' || category === 'analog' || category === 'gpio' ? category : 'other';
}
