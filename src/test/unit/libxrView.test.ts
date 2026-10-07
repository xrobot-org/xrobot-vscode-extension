import * as assert from 'assert';

import { cliActions, libxrUpgradeHint, platformTitle, setupAction, sourceToolLabel, sysconfigEnvHint, watcherPatterns } from '../../libxrView';

const base = {
	xrobotBsp: false,
	appMainRel: 'User/app_main.cpp',
	libxrConfigRel: 'User/libxr_config.yaml',
	projectDir: '.',
};

suite('LibXR view per platform', () => {
	test('the platform and the tool of its chip source file are named', () => {
		const platforms = ['stm32', 'mspm0', 'hpm', 'unknown'] as const;
		assert.deepStrictEqual(platforms.map(platformTitle), ['STM32', 'MSPM0', 'HPM', 'Project']);
		assert.deepStrictEqual((['stm32', 'mspm0', 'hpm'] as const).map(sourceToolLabel), ['STM32CubeMX', 'SysConfig', 'HPM Pinmux Tool']);
	});

	test('the setup action of each platform runs its own one-step setup', () => {
		const stm32 = setupAction('stm32', false);
		assert.strictEqual(stm32.label, 'Configure CubeMX (libxr stm32 setup)');
		assert.deepStrictEqual(stm32.request, { label: 'libxr stm32 setup', tool: 'libxr', args: ['stm32', 'setup', '-d', '.'] });
		const hpm = setupAction('hpm', true);
		assert.strictEqual(hpm.label, 'Set Up HPM Project (libxr hpm setup)');
		assert.deepStrictEqual(hpm.request, { label: 'libxr hpm setup', tool: 'libxr', args: ['hpm', 'setup', '-d', '.'] });
		const mspm0 = setupAction('mspm0', false);
		assert.strictEqual(mspm0.label, 'Set Up MSPM0 Project (libxr mspm0 setup)');
		assert.deepStrictEqual(mspm0.request, { label: 'libxr mspm0 setup', tool: 'libxr', args: ['mspm0', 'setup', '-d', '.'] });
	});

	test('an XRobot BSP sets up STM32 with --xrobot', () => {
		assert.deepStrictEqual(setupAction('stm32', true).request.args, ['stm32', 'setup', '-d', '.', '--xrobot']);
	});

	test('a configured MSPM0 or HPM project keeps only the one-click generation', () => {
		// The one-click Generate LibXR Code is an op of the view, not a CLI action here.
		assert.deepStrictEqual(cliActions({ ...base, platform: 'mspm0' }), []);
		assert.deepStrictEqual(cliActions({ ...base, platform: 'hpm' }), []);
	});

	test('a configured STM32 project keeps its actions with editable arguments', () => {
		const actions = cliActions({ ...base, platform: 'stm32', flashModel: 'STM32F103C8T6' });
		assert.deepStrictEqual(
			actions.map((action) => action.request.label),
			['libxr stm32 setup', 'libxr parse', 'libxr gen', 'libxr stm32 flash-info'],
		);
		const gen = actions[2].request;
		assert.strictEqual(
			gen.defaultInput,
			'-i ./.config.yaml -d . -o ./User/app_main.cpp --libxr-config ./User/libxr_config.yaml',
		);
		assert.strictEqual(gen.inputPrompt, `Example: ${gen.defaultInput}`);
		const flashInfo = actions[3].request;
		assert.strictEqual(flashInfo.defaultInput, 'STM32F103C8T6');
		const withoutModel = cliActions({ ...base, platform: 'stm32' });
		assert.strictEqual(withoutModel[3].request.defaultInput, 'STM32F103C8');
	});

	test('a configured STM32 project of an XRobot BSP generates with --xrobot', () => {
		const actions = cliActions({ ...base, platform: 'stm32', xrobotBsp: true });
		assert.ok(actions[2].request.defaultInput?.endsWith(' --xrobot --libxr-config ./User/libxr_config.yaml'));
	});
});

suite('LibXR view watchers', () => {
	test('the patterns follow every platform input and no generated header', () => {
		const patterns = watcherPatterns();
		for (const expected of ['*.ioc', 'app.yaml', 'boards/*/*.hpmpc', '*.syscfg', 'main.c']) {
			assert.ok(patterns.includes(expected), `${expected} missing`);
		}
		// The MSPM0 project is recognized from its .syscfg; the generated header is no input.
		assert.ok(!patterns.some((pattern) => pattern.includes('ti_msp_dl_config.h')));
	});
});

suite('LibXR CLI hints', () => {
	// The real messages of libxr 6.0.0 (it names only stm32).
	const oldCli = {
		setup: "libxr: error: argument <command>: invalid choice: 'mspm0' (choose from parse, gen, stm32)",
		hpmSetup: "libxr: error: argument <command>: invalid choice: 'hpm' (choose from parse, gen, stm32)",
		pins: "libxr: error: argument <command>: invalid choice: 'pins' (choose from parse, gen, stm32)",
		parse: 'hpmproj: no supported platform recognized (stm32: a directory with an STM32CubeMX .ioc file)',
	};

	test('the failures of an old libxr say to upgrade it', () => {
		for (const message of Object.values(oldCli)) {
			assert.match(libxrUpgradeHint(message) ?? '', /^The installed libxr is too old/);
		}
		assert.strictEqual(libxrUpgradeHint('Traceback (most recent call last): ...'), undefined);
	});

	test('the missing-environment error of an MSPM0 parse points at the settings', () => {
		const message =
			'mspm0proj: no SysConfig output newer than g3507.syscfg found under build*, and SYSCONFIG_TOOL or ' +
			'MSPM0_SDK_INSTALL_DIR is not set (the environment variables the CMake build uses). Build the project ' +
			'once, or set them and run `libxr parse` again.';
		assert.match(sysconfigEnvHint(message) ?? '', /^Set SysConfig up for MSPM0/);
		assert.strictEqual(sysconfigEnvHint(oldCli.parse), undefined);
	});
});
