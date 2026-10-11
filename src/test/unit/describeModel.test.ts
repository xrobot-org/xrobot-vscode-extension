import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	containsNull,
	fieldAt,
	fieldShape,
	findMatchingConstructor,
	matchedParameter,
	matchingShapeConstructor,
	opaqueReason,
	parameterCandidates,
	parameterShape,
	parseDescribeOutput,
	seedMapping,
	shouldRegenerate,
	switchConstructorArgs,
	typeShape,
	type DescribeConstructor,
	type DescribeResult,
} from '../../providers/describeModel';

// Trimmed from real `xrobot describe -c User/RobotConfig/hero.yaml` output (bsp-dev-c,
// xrobot 1.0.0, schema 1).
const FIXTURE = fs.readFileSync(path.resolve(__dirname, '../../../src/test/unit/fixtures/describe-hero.json'), 'utf8');

function load(): DescribeResult {
	const parsed = parseDescribeOutput(FIXTURE);
	assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
	return parsed.value;
}

suite('parseDescribeOutput', () => {
	test('reads the schema 1 fields the view uses', () => {
		const d = load();
		assert.strictEqual(d.config, 'User/RobotConfig/hero.yaml');
		assert.strictEqual(d.selected, 'User/xrobot.yaml');
		assert.ok(d.configs.includes('User/RobotConfig/hero.yaml'));
		assert.strictEqual(d.header.path, 'User/xrobot_main.hpp');
		assert.strictEqual(d.tools.xrobot.installed, '1.0.0');
		assert.strictEqual(d.lock.status, 'ok');
		assert.deepStrictEqual(
			d.instances.map((i) => i.id),
			['blink_led', 'cmd', 'motor_trig'],
		);
		assert.deepStrictEqual(d.instances[0].candidates.led, ['LED_B', 'LED_R']);
	});

	test('rejects other schemas, non-objects and invalid JSON', () => {
		const other = parseDescribeOutput(JSON.stringify({ ...JSON.parse(FIXTURE), schema: 2 }));
		assert.ok(!other.ok && /schema 2/.test(other.error));
		assert.ok(!parseDescribeOutput('[]').ok);
		assert.ok(!parseDescribeOutput('{').ok);
		assert.ok(!parseDescribeOutput(JSON.stringify({ schema: 1 })).ok);
	});

	test('keeps non-ASCII configuration text', () => {
		const data = JSON.parse(FIXTURE);
		data.instances[0].args[1] = { blink_cycle: '"闪烁"' };
		const parsed = parseDescribeOutput(JSON.stringify(data));
		assert.ok(parsed.ok);
		assert.deepStrictEqual(parsed.value.instances[0].args[1], { blink_cycle: '"闪烁"' });
	});
});

suite('constructor matching and candidates', () => {
	test('matches the constructor by parameter names in order', () => {
		const d = load();
		const blink = d.modules['xrobot-org/BlinkLED'];
		assert.strictEqual(findMatchingConstructor(blink, [{ led: 'LED_B' }, { blink_cycle: '250' }]), 0);
		assert.strictEqual(findMatchingConstructor(blink, [{ blink_cycle: '250' }, { led: 'LED_B' }]), -1);
		assert.strictEqual(findMatchingConstructor(blink, [{ led: 'LED_B' }]), -1);
		assert.strictEqual(findMatchingConstructor(undefined, []), -1);
	});

	test('candidates come from the instance, else from the parameter', () => {
		const d = load();
		const blinkLed = d.instances[0];
		const param = matchedParameter(d.modules[blinkLed.module], blinkLed, 'led');
		assert.strictEqual(param?.type, 'LibXR::GPIO&');
		assert.strictEqual(param?.dependency, true);
		assert.deepStrictEqual(parameterCandidates(blinkLed, 'led', param), ['LED_B', 'LED_R']);
		assert.deepStrictEqual(parameterCandidates({ ...blinkLed, candidates: {} }, 'led', param), param?.candidates);
	});
});

suite('mapping shapes', () => {
	test('designated defaults fix the keys of an aggregate parameter', () => {
		const d = load();
		const motor = d.modules['QDU-Robomaster/RMMotor'];
		const param = motor.constructors![0].parameters[1];
		const shape = parameterShape(param, d.types);
		assert.ok(shape && shape.kind === 'fields');
		assert.deepStrictEqual(shape.fields.map((f) => f.name), ['model', 'reverse', 'feedback_id']);
		assert.strictEqual(shape.fields[2].type, 'uint16_t');
		assert.deepStrictEqual(seedMapping(shape.fields, undefined), {
			model: 'RMMotor::Model::MOTOR_M3508',
			reverse: 'false',
			feedback_id: '0x201',
		});
		assert.deepStrictEqual(seedMapping(shape.fields, { reverse: 'true' }).reverse, 'true');
	});

	test('class types offer their constructors; opaque types have no shape', () => {
		const d = load();
		const cmd = typeShape('CMD', d.types);
		assert.ok(cmd && cmd.kind === 'constructors');
		assert.deepStrictEqual(cmd.constructors[0].map((f) => f.name), [
			'mode',
			'chassis_cmd_topic_name',
			'gimbal_cmd_topic_name',
			'launcher_cmd_topic_name',
		]);
		assert.strictEqual(matchingShapeConstructor(cmd.constructors, { mode: 'x', chassis_cmd_topic_name: 'a', gimbal_cmd_topic_name: 'b', launcher_cmd_topic_name: 'c' }), 0);
		assert.strictEqual(matchingShapeConstructor(cmd.constructors, 'text'), -1);
		assert.strictEqual(typeShape('Motor', d.types), undefined);
		assert.match(opaqueReason('Motor', d.types) ?? '', /base classes/);
		assert.strictEqual(fieldShape({ name: 'x', typeRef: 'Motor' }, d.types), undefined);
	});

	test('fieldAt follows mapping keys below a parameter', () => {
		const d = load();
		const param = d.modules['QDU-Robomaster/RMMotor'].constructors![0].parameters[1];
		assert.strictEqual(fieldAt(param, ['feedback_id'], undefined, d.types)?.type, 'uint16_t');
		assert.strictEqual(fieldAt(param, ['missing'], undefined, d.types), undefined);
		assert.strictEqual(fieldAt(param, [0], undefined, d.types), undefined);
		assert.strictEqual(fieldAt(undefined, ['model'], undefined, d.types), undefined);
	});

	test('containsNull finds unfilled values at any depth', () => {
		assert.strictEqual(containsNull({ a: '1', b: ['2', { c: null }] }), true);
		assert.strictEqual(containsNull({ a: '1', b: ['2'] }), false);
	});
});

suite('constructor switch', () => {
	// BlinkLED with a second constructor, as `xrobot describe` reports it (scratch BSP).
	const frequencyCtor: DescribeConstructor = {
		line: 59,
		parameters: [
			{ name: 'led', type: 'LibXR::GPIO&', default: null, dependency: true, default_fields: null, type_ref: null, candidates: [] },
			{ name: 'frequency_hz', type: 'float', default: '2.0f', dependency: false, default_fields: null, type_ref: null, candidates: [] },
			{ name: 'inverted', type: 'bool', default: 'false', dependency: false, default_fields: null, type_ref: null, candidates: [] },
		],
	};

	test('keeps same-named values, defaults only new parameters, reports dropped ones', () => {
		const change = switchConstructorArgs([{ led: '"闪烁"' }, { blink_cycle: '500' }], frequencyCtor);
		assert.deepStrictEqual(change.args, [{ led: '"闪烁"' }, { frequency_hz: '2.0f' }, { inverted: 'false' }]);
		assert.deepStrictEqual(change.kept, ['led']);
		assert.deepStrictEqual(change.added, ['frequency_hz', 'inverted']);
		assert.deepStrictEqual(change.dropped, ['blink_cycle']);
	});

	test('a user value wins over the default; new dependencies stay null; mappings are copied', () => {
		const d = load();
		const motorCtor = d.modules['QDU-Robomaster/RMMotor'].constructors![0];
		const current = [{ param: { model: 'X', reverse: 'true', feedback_id: '0x205' } }];
		const change = switchConstructorArgs(current, motorCtor);
		assert.deepStrictEqual(change.args, [{ can_bus: null }, { param: { model: 'X', reverse: 'true', feedback_id: '0x205' } }]);
		assert.deepStrictEqual(change.added, ['can_bus']);
		(change.args[1].param as Record<string, string>).model = 'changed';
		assert.strictEqual(current[0].param.model, 'X', 'the current args are not modified');
		// A new parameter with a designated default gets its mapping.
		assert.deepStrictEqual(switchConstructorArgs([], motorCtor).args[1], {
			param: { model: 'RMMotor::Model::MOTOR_M3508', reverse: 'false', feedback_id: '0x201' },
		});
	});
});

suite('shouldRegenerate', () => {
	test('only for the selected product, without errors, when the header is not fresh', () => {
		const d = load();
		const selected = { ...d, config: d.selected };
		assert.strictEqual(shouldRegenerate(selected), true);
		assert.strictEqual(shouldRegenerate(d), false, 'not the selected product');
		assert.strictEqual(shouldRegenerate({ ...selected, header: { ...d.header, status: 'fresh' } }), false);
		assert.strictEqual(
			shouldRegenerate({ ...selected, diagnostics: [{ severity: 'error', scope: 'User/xrobot.yaml', message: 'x: null value' }] }),
			false,
		);
	});
});
