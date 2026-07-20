/**
 * Run: npx tsx --test src/proxyResolvePatch.range.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpstreamMediaHeaders } from './proxyResolvePatch.js';
import { normalizeUpstreamMediaUrl } from './utils/streamUrl.js';

describe('buildUpstreamMediaHeaders', () => {
    it('strips Connection keep-alive and forwards Range once', () => {
        const out = buildUpstreamMediaHeaders(
            {
                'User-Agent': 'Mozilla/5.0',
                Connection: 'keep-alive',
                Referer: 'https://vidlink.pro/',
                Origin: 'https://vidlink.pro',
                Range: 'bytes=0-1'
            },
            'bytes=0-1023'
        );
        assert.equal(out['Connection'], undefined);
        assert.equal(out['connection'], undefined);
        assert.equal(out['Range'], 'bytes=0-1023');
        assert.equal(out['Referer'], 'https://vidlink.pro/');
        assert.equal(out['User-Agent'], 'Mozilla/5.0');
    });

    it('uses provider Range when client does not send one', () => {
        const out = buildUpstreamMediaHeaders({
            range: 'bytes=100-200',
            'Keep-Alive': 'timeout=5'
        });
        assert.equal(out['Range'], 'bytes=100-200');
        assert.equal(out['Keep-Alive'], undefined);
    });
});

describe('normalizeUpstreamMediaUrl (proxy path)', () => {
    it('never leaves token=?token= for streaming segments', () => {
        const dirty =
            'https://strategicgrowthpartners.site/8Ybx/content/aa/bb/page-0.html?token=?token=';
        const clean = normalizeUpstreamMediaUrl(dirty);
        assert.equal(clean.includes('token=?token='), false);
        assert.equal(clean.includes('?token=?'), false);
    });
});
