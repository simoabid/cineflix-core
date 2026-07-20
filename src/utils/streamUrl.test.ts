/**
 * Run: npx tsx --test src/utils/streamUrl.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    hasMalformedMediaToken,
    mergeNonEmptyQuery,
    normalizeUpstreamMediaUrl
} from './streamUrl.js';

describe('hasMalformedMediaToken', () => {
    it('flags double token pattern', () => {
        assert.equal(
            hasMalformedMediaToken(
                'https://cdn.example/content/x/page-0.html?token=?token='
            ),
            true
        );
    });

    it('allows empty token (upstream sometimes uses it)', () => {
        assert.equal(
            hasMalformedMediaToken(
                'https://cdn.example/pl/x/index.m3u8?token='
            ),
            false
        );
    });

    it('allows normal signed URLs', () => {
        assert.equal(
            hasMalformedMediaToken(
                'https://cdn.example/seg.ts?token=abc&expires=123'
            ),
            false
        );
    });
});

describe('normalizeUpstreamMediaUrl', () => {
    it('strips token=?token= corruption', () => {
        const out = normalizeUpstreamMediaUrl(
            'https://strategicgrowthpartners.site/x/content/aa/page-0.html?token=?token='
        );
        assert.equal(out.includes('token=?token='), false);
        assert.equal(out.includes('?token=?'), false);
        assert.match(out, /^https:\/\/strategicgrowthpartners\.site\//);
    });

    it('preserves legitimate query params', () => {
        const out = normalizeUpstreamMediaUrl(
            'https://cdn.example/a.m3u8?token=abc&expires=99'
        );
        assert.equal(out.includes('token=abc'), true);
        assert.equal(out.includes('expires=99'), true);
    });
});

describe('mergeNonEmptyQuery', () => {
    it('does not copy empty parent token onto child', () => {
        const out = mergeNonEmptyQuery(
            'https://cdn.example/index.m3u8?token=',
            'https://cdn.example/page-0.html'
        );
        assert.equal(out.includes('token='), false);
    });

    it('copies non-empty parent params', () => {
        const out = mergeNonEmptyQuery(
            'https://cdn.example/index.m3u8?token=abc&x=1',
            'https://cdn.example/page-0.html'
        );
        assert.equal(out.includes('token=abc'), true);
        assert.equal(out.includes('x=1'), true);
    });
});
