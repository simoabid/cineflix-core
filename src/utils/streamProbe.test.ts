/**
 * Run: npx tsx --test src/utils/streamProbe.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    absRef,
    isMpegTs,
    looksLikePlayableHls,
    probeSource
} from './streamProbe.js';

describe('looksLikePlayableHls', () => {
    it('accepts basic media playlist', () => {
        const text = `#EXTM3U
#EXTINF:4,
seg-1-v1.ts
#EXTINF:4,
seg-2-v1.ts
`;
        assert.equal(looksLikePlayableHls(text), true);
    });

    it('accepts disguised page-N.html segments (vidlove style)', () => {
        const text = `#EXTM3U
#EXTINF:6,
../../content/aa/bb/page-0.html?token=
#EXTINF:6,
../../content/aa/bb/page-1.html?token=
`;
        assert.equal(looksLikePlayableHls(text), true);
    });

    it('rejects empty', () => {
        assert.equal(looksLikePlayableHls('not a playlist'), false);
    });
});

describe('absRef', () => {
    it('resolves relative segments against playlist dir', () => {
        const base =
            'https://cdn.example/pl/xxx/0f9b/index.m3u8?token=';
        const out = absRef(base, 'page-0.html?token=');
        assert.equal(
            out,
            'https://cdn.example/pl/xxx/0f9b/page-0.html?token='
        );
    });

    it('does not invent token=?token=', () => {
        const base =
            'https://cdn.example/pl/xxx/index.m3u8?token=';
        const out = absRef(base, 'page-0.html');
        assert.equal(out.includes('token=?token='), false);
        assert.equal(out, 'https://cdn.example/pl/xxx/page-0.html');
    });
});

describe('isMpegTs', () => {
    it('detects sync bytes', () => {
        const buf = new Uint8Array(188 * 4);
        for (let i = 0; i < 4; i++) buf[i * 188] = 0x47;
        assert.equal(isMpegTs(buf), true);
    });
});

describe('probeSource', () => {
    it('rejects malformed token without network', async () => {
        const r = await probeSource({
            url: 'https://cdn.example/page-0.html?token=?token=',
            label: 'test'
        });
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.reason, 'malformed_token');
    });
});
