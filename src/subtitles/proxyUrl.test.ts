/**
 * Run: npx tsx --test src/subtitles/proxyUrl.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    createSubtitleProxyUrl,
    getProxyBaseUrl,
    proxySubtitleUrls
} from './proxyUrl.js';

describe('subtitle file URL rewrite', () => {
    beforeEach(() => {
        process.env.PUBLIC_URL = 'https://core.cineflix.dev';
    });

    it('uses /v1/subtitles/file for OpenSubtitles', () => {
        assert.equal(getProxyBaseUrl(), 'https://core.cineflix.dev');
        const raw =
            'https://dl.opensubtitles.org/en/download/subencoding-utf8/file/1';
        const u = createSubtitleProxyUrl(raw);
        assert.equal(
            u,
            `https://core.cineflix.dev/v1/subtitles/file?url=${encodeURIComponent(raw)}`
        );
    });

    it('keeps vdrk-style /v1/proxy links', () => {
        const vdrk =
            'https://core.cineflix.dev/v1/proxy?data=%7B%22url%22%3A%22https%3A%2F%2Fcache.vdrk.site%2Fa.vtt%22%7D';
        assert.equal(createSubtitleProxyUrl(vdrk), vdrk);
    });

    it('rewrites OS links still on /v1/proxy', () => {
        const inner =
            'https://dl.opensubtitles.org/en/download/subencoding-utf8/file/9';
        const bad =
            'https://core.cineflix.dev/v1/proxy?data=' +
            encodeURIComponent(JSON.stringify({ url: inner }));
        const out = createSubtitleProxyUrl(bad);
        assert.ok(out.includes('/v1/subtitles/file?url='));
        assert.ok(out.includes(encodeURIComponent(inner)));
    });

    it('proxySubtitleUrls maps list', () => {
        const out = proxySubtitleUrls([
            {
                url: 'https://dl.opensubtitles.org/en/download/file/1',
                label: 'en'
            }
        ]);
        assert.ok(out[0]!.url.includes('/v1/subtitles/file?'));
    });
});
