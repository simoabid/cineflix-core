/**
 * Run with: npx tsx --test src/subtitles/wyzieKeys.test.ts
 * (no vitest in core package)
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    markWyzieKeyFailed,
    markWyzieKeySuccess,
    pickWyzieKey,
    resetWyzieKeyPoolForTests,
    wyzieKeyCount
} from './wyzieKeys.js';

describe('wyzie key rotation', () => {
    beforeEach(() => {
        resetWyzieKeyPoolForTests();
        process.env.WYZIE_API_KEYS = 'wyzie-key-a,wyzie-key-b,wyzie-key-c';
    });

    it('parses multiple keys', () => {
        assert.equal(wyzieKeyCount(), 3);
    });

    it('round-robins ready keys', () => {
        const a = pickWyzieKey();
        const b = pickWyzieKey();
        const c = pickWyzieKey();
        const d = pickWyzieKey();
        assert.ok(a && b && c);
        assert.notEqual(a, b);
        assert.notEqual(b, c);
        // fourth wraps
        assert.equal(d, a);
    });

    it('skips cooled keys after rate_limit', () => {
        const first = pickWyzieKey();
        assert.ok(first);
        markWyzieKeyFailed(first, 'rate_limit');
        const next = pickWyzieKey();
        assert.ok(next);
        assert.notEqual(next, first);
        // Exhaust remaining — should not return cooled first immediately
        const seen = new Set<string>([next!]);
        for (let i = 0; i < 5; i++) {
            const k = pickWyzieKey();
            if (k) seen.add(k);
        }
        // first is cooled so pool should only offer other keys
        assert.equal(seen.has(first), false);
    });

    it('clears cooldown on success', () => {
        const first = pickWyzieKey()!;
        markWyzieKeyFailed(first, 'error');
        markWyzieKeySuccess(first);
        // Eventually should be pickable again
        const picks = new Set<string>();
        for (let i = 0; i < 6; i++) {
            const k = pickWyzieKey();
            if (k) picks.add(k);
        }
        assert.equal(picks.has(first), true);
    });
});
