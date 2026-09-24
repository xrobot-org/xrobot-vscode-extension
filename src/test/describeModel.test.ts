import * as assert from 'assert';

import {
	buildDescribeArgs,
	buildGenMainArgs,
	buildInstanceAddArgs,
	buildInstanceRemoveArgs,
	buildInstanceSetArgs,
	buildSetupArgs,
	changedEntryInputs,
	defaultArgsForConstructor,
	fieldShape,
	findMatchingConstructor,
	matchingShapeConstructor,
	parameterShape,
	parseDescribeOutput,
	seedMapping,
	withArgValue,
	withTemplateArg,
	type DescribeModule,
	type DescribeResult,
	type XrobotPaths,
} from '../providers/describeModel';

// Trimmed from real `xrobot_describe` output (bsp-dev-c, schema 1).
const BLINK: DescribeModule = {
	id: 'xrobot-org/BlinkLED',
	class: 'BlinkLED',
	header: 'Modules/xrobot-org/BlinkLED/BlinkLED.hpp',
	standalone: true,
	template_parameters: [],
	constructors: [
		{
			line: 12,
			parameters: [
				{ name: 'led', type: 'LibXR::GPIO&', default: null, default_fields: null, type_ref: null, candidates: ['LED_B', 'LED_G'] },
				{ name: 'blink_cycle', type: 'uint32_t', default: '250', default_fields: null, type_ref: null, candidates: [] },
			],
		},
		{
			line: 20,
			parameters: [{ name: 'led', type: 'LibXR::GPIO&', default: null, default_fields: null, type_ref: null, candidates: ['LED_B'] }],
		},
	],
};

function sampleDescribe(): DescribeResult {
	const raw = {
		schema: 1,
		config: 'User/xrobot.yaml',
		lock: { path: 'xrobot.lock', present: true, status: 'ok', modules: [] },
		entry: {
			path: 'User/xrobot_main.hpp',
			status: 'stale',
			inputs: [
				{ kind: 'config', path: 'xrobot.yaml', recorded: 'a', current: 'b', status: 'stale' },
				{ kind: 'lock', path: '../xrobot.lock', recorded: 'c', current: 'c', status: 'fresh' },
			],
		},
		registrations: [{ name: 'LED_B', types: ['LibXR::GPIO'] }],
		modules: {
			'xrobot-org/BlinkLED': BLINK,
			'QDU-Robomaster/RMMotor': {
				id: 'QDU-Robomaster/RMMotor',
				class: 'RMMotor',
				standalone: true,
				template_parameters: [],
				constructors: [
					{
						line: 30,
						parameters: [
							{
								name: 'param',
								type: 'const RMMotor::Param&',
								default: '{.model = RMMotor::Model::MOTOR_M3508, .reverse = false, .feedback_id = 0x201}',
								default_fields: { model: 'RMMotor::Model::MOTOR_M3508', reverse: 'false', feedback_id: '0x201' },
								type_ref: 'RMMotor::Param',
								candidates: [],
							},
						],
					},
				],
			},
		},
		types: {
			'RMMotor::Param': {
				kind: 'aggregate',
				fields: [
					{ name: 'model', type: 'RMMotor::Model', type_ref: null },
					{ name: 'reverse', type: 'bool', type_ref: null },
					{ name: 'feedback_id', type: 'uint32_t', type_ref: null },
				],
			},
			'Chassis::Param': {
				kind: 'aggregate',
				fields: [
					{ name: 'wheel', type: 'RMMotor::Param', type_ref: 'RMMotor::Param' },
					{ name: 'limits', type: 'Wheel::Limits', type_ref: 'Wheel::Limits' },
				],
			},
			'Wheel::Limits': {
				kind: 'class',
				constructors: [
					[{ name: 'max_speed', type: 'float', type_ref: null, default: '1.0f' }],
					[
						{ name: 'max_speed', type: 'float', type_ref: null, default: null },
						{ name: 'max_accel', type: 'float', type_ref: null, default: '2.0f' },
					],
				],
			},
		},
		instances: [
			{ id: 'blinkled_0', module: 'xrobot-org/BlinkLED', class: 'BlinkLED', template_args: [], args: [{ led: 'LED_B' }, { blink_cycle: '250' }] },
		],
		diagnostics: [{ severity: 'warning', scope: 'User/xrobot_main.hpp', message: 'generated from older xrobot.yaml; regenerate it' }],
	};
	const parsed = parseDescribeOutput(JSON.stringify(raw));
	assert.ok(parsed.ok);
	return parsed.ok ? parsed.value : (undefined as never);
}

const PATHS: XrobotPaths = {
	root: 'D:/BSP/bsp-dev-c',
	config: 'User/RobotConfig/hero.yaml',
	registerSource: 'User/app_main.cpp',
	header: 'User/xrobot_main.hpp',
	lock: 'xrobot.lock',
};

suite('describeModel: parsing', () => {
	test('accepts schema 1 and rejects others', () => {
		assert.strictEqual(sampleDescribe().instances.length, 1);
		const wrong = parseDescribeOutput(JSON.stringify({ schema: 2 }));
		assert.strictEqual(wrong.ok, false);
		assert.strictEqual(parseDescribeOutput('not json').ok, false);
	});

	test('reports changed entry inputs', () => {
		const changed = changedEntryInputs(sampleDescribe().entry);
		assert.deepStrictEqual(changed.map((i) => i.kind), ['config']);
	});
});

suite('describeModel: CLI arguments', () => {
	test('describe / gen_main / setup pass config, register source, header and lock', () => {
		assert.deepStrictEqual(buildDescribeArgs(PATHS), [
			'-C', 'D:/BSP/bsp-dev-c', '-c', 'User/RobotConfig/hero.yaml', '-o', 'User/xrobot_main.hpp',
			'--register-source', 'User/app_main.cpp', '--lock', 'xrobot.lock',
		]);
		assert.deepStrictEqual(buildGenMainArgs(PATHS), [
			'-c', 'User/RobotConfig/hero.yaml', '-o', 'User/xrobot_main.hpp', '--register-source', 'User/app_main.cpp', '--lock', 'xrobot.lock',
		]);
		assert.deepStrictEqual(buildSetupArgs(PATHS, 'frozen'), ['--frozen', '-c', 'User/RobotConfig/hero.yaml', '--register-source', 'User/app_main.cpp']);
		assert.deepStrictEqual(buildSetupArgs(PATHS, 'update').slice(0, 1), ['--update']);
		assert.deepStrictEqual(buildSetupArgs({ ...PATHS, registerSource: undefined }), ['-c', 'User/RobotConfig/hero.yaml']);
	});

	test('xrobot_instance puts -c before the subcommand and JSON in one argv element', () => {
		assert.deepStrictEqual(buildInstanceAddArgs('User/xrobot.yaml', 'xrobot-org/BlinkLED'), ['-c', 'User/xrobot.yaml', 'add', 'xrobot-org/BlinkLED']);
		assert.deepStrictEqual(buildInstanceAddArgs('User/xrobot.yaml', 'xrobot-org/BlinkLED', ' led_0 '), [
			'-c', 'User/xrobot.yaml', 'add', 'xrobot-org/BlinkLED', '--id', 'led_0',
		]);
		assert.deepStrictEqual(buildInstanceRemoveArgs('User/xrobot.yaml', 'led_0'), ['-c', 'User/xrobot.yaml', 'remove', 'led_0']);
		const args = buildInstanceSetArgs('User/xrobot.yaml', 'led_0', { args: [{ led: 'LED_B' }, { name: '"a b"' }] });
		assert.strictEqual(args.length, 5);
		assert.deepStrictEqual(args.slice(0, 4), ['-c', 'User/xrobot.yaml', 'set', 'led_0']);
		assert.deepStrictEqual(JSON.parse(args[4]), { args: [{ led: 'LED_B' }, { name: '"a b"' }] });
	});
});

suite('describeModel: args', () => {
	test('matches the constructor by ordered parameter names', () => {
		assert.strictEqual(findMatchingConstructor(BLINK, [{ led: 'LED_B' }, { blink_cycle: '250' }]), 0);
		assert.strictEqual(findMatchingConstructor(BLINK, [{ led: 'LED_B' }]), 1);
		assert.strictEqual(findMatchingConstructor(BLINK, [{ blink_cycle: '250' }, { led: 'LED_B' }]), -1);
	});

	test('resets args to constructor defaults (designated fields preferred, null when none)', () => {
		const describe = sampleDescribe();
		assert.deepStrictEqual(defaultArgsForConstructor(BLINK.constructors![0]), [{ led: null }, { blink_cycle: '250' }]);
		const motor = describe.modules['QDU-Robomaster/RMMotor'].constructors![0];
		assert.deepStrictEqual(defaultArgsForConstructor(motor), [
			{ param: { model: 'RMMotor::Model::MOTOR_M3508', reverse: 'false', feedback_id: '0x201' } },
		]);
	});

	test('replaces one arg in place and keeps order', () => {
		const next = withArgValue([{ led: 'LED_B' }, { blink_cycle: '250' }], 'led', 'LED_G');
		assert.deepStrictEqual(next, [{ led: 'LED_G' }, { blink_cycle: '250' }]);
	});

	test('fills template args up to the edited index with defaults', () => {
		const params = [
			{ name: 'ChassisType', type: 'typename', default: null },
			{ name: 'N', type: 'int', default: '4' },
		];
		assert.deepStrictEqual(withTemplateArg([], params, 0, 'Mecanum'), ['Mecanum', '4']);
		assert.deepStrictEqual(withTemplateArg(['Mecanum', '4'], params, 1, '2'), ['Mecanum', '2']);
	});
});

suite('describeModel: mapping shapes', () => {
	test('designated default fields fix the mapping keys and order', () => {
		const describe = sampleDescribe();
		const param = describe.modules['QDU-Robomaster/RMMotor'].constructors![0].parameters[0];
		const shape = parameterShape(param, describe.types);
		assert.ok(shape && shape.kind === 'fields');
		assert.deepStrictEqual(shape.kind === 'fields' ? shape.fields.map((f) => [f.name, f.type]) : [], [
			['model', 'RMMotor::Model'],
			['reverse', 'bool'],
			['feedback_id', 'uint32_t'],
		]);
		// A positional list of the same length is zipped onto the field names.
		const seeded = seedMapping(shape.kind === 'fields' ? shape.fields : [], ['RMMotor::Model::MOTOR_M3508', 'true', '516']);
		assert.deepStrictEqual(seeded, { model: 'RMMotor::Model::MOTOR_M3508', reverse: 'true', feedback_id: '516' });
		assert.deepStrictEqual(Object.keys(seeded), ['model', 'reverse', 'feedback_id']);
	});

	test('aggregate fields recurse through type_ref; unknown keys are dropped when seeding', () => {
		const describe = sampleDescribe();
		const shape = parameterShape(
			{ name: 'param', type: 'const Chassis::Param&', default: null, default_fields: null, type_ref: 'Chassis::Param', candidates: [] },
			describe.types,
		);
		assert.ok(shape && shape.kind === 'fields');
		const fields = shape.kind === 'fields' ? shape.fields : [];
		assert.deepStrictEqual(seedMapping(fields, { limits: '{1.0f}', extra: 'x' }), { wheel: null, limits: '{1.0f}' });
		const wheel = fieldShape(fields[0], describe.types);
		assert.ok(wheel && wheel.kind === 'fields');
		const limits = fieldShape(fields[1], describe.types);
		assert.ok(limits && limits.kind === 'constructors');
	});

	test('class shapes select a constructor by the mapping keys', () => {
		const describe = sampleDescribe();
		const shape = fieldShape({ name: 'limits', typeRef: 'Wheel::Limits' }, describe.types);
		assert.ok(shape && shape.kind === 'constructors');
		const ctors = shape.kind === 'constructors' ? shape.constructors : [];
		assert.strictEqual(matchingShapeConstructor(ctors, { max_speed: '3.0f', max_accel: '1.0f' }), 1);
		assert.strictEqual(matchingShapeConstructor(ctors, { max_speed: '3.0f' }), 0);
		assert.strictEqual(matchingShapeConstructor(ctors, '{3.0f}'), -1);
		assert.deepStrictEqual(seedMapping(ctors[1], undefined), { max_speed: null, max_accel: '2.0f' });
	});
});
