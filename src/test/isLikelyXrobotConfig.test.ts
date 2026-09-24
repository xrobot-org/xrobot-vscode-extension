import * as assert from 'assert';

import { isLikelyXrobotConfig } from '../providers/xrobotConfigUtils';

suite('isLikelyXrobotConfig', () => {
	test('returns true when modules is an array', () => {
		assert.strictEqual(isLikelyXrobotConfig({ modules: [] }), true);
		assert.strictEqual(isLikelyXrobotConfig({ modules: [{ module: 'xrobot-org/BlinkLED', id: 'blinkled_0' }] }), true);
	});

	test('returns true when settings is an object', () => {
		assert.strictEqual(isLikelyXrobotConfig({ settings: { monitor_sleep_ms: 1000 } }), true);
	});

	test('returns false for unrelated shapes', () => {
		assert.strictEqual(isLikelyXrobotConfig({}), false);
		assert.strictEqual(isLikelyXrobotConfig({ modules: 'BlinkLED' }), false);
		assert.strictEqual(isLikelyXrobotConfig({ settings: 'yes' }), false);
	});
});
