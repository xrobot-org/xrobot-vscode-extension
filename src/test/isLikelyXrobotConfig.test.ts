import * as assert from 'assert';

import { isLikelyXrobotConfig } from '../providers/xrobotConfigUtils';

suite('isLikelyXrobotConfig', () => {
	test('returns true when modules is an array', () => {
		assert.strictEqual(isLikelyXrobotConfig({ modules: [] }), true);
		assert.strictEqual(isLikelyXrobotConfig({ modules: ['BlinkLED'] }), true);
	});

	test('returns true when global_settings is an object', () => {
		assert.strictEqual(isLikelyXrobotConfig({ global_settings: { monitor_sleep_ms: 1000 } }), true);
	});

	test('returns false for unrelated shapes', () => {
		assert.strictEqual(isLikelyXrobotConfig({}), false);
		assert.strictEqual(isLikelyXrobotConfig({ modules: 'BlinkLED' }), false);
		assert.strictEqual(isLikelyXrobotConfig({ global_settings: 'yes' }), false);
	});
});
