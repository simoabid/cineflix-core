/**
 * Run: npx tsx --test src/subtitles/proxyUrl.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    createSubtitleProxyUrl,
    getProxyBaseUrl,
    normalizeSubtitleDownloadUrl,
    proxySubtitleUrls,
    unwrapSubtitleUpstream
} from './proxyUrl.js';

describe('subtitle download URL normalize (browser-first Path B)', () => {
    beforeEach(() => {
        process.env.PUBLIC_URL = 'https://core.cineflix.dev';
    });

    it('keeps raw OpenSubtitles URLs unchanged', () => {
        assert.equal(getProxyBaseUrl(), 'https://core.cineflix.dev');
        const raw =
            'https://dl.opensubtitles.org/en/download/subencoding-utf8/file/1';
        assert.equal(normalizeSubtitleDownloadUrl(raw), raw);
        assert.equal(createSubtitleProxyUrl(raw), raw);
    });

    it('unwraps OS links stuck on /v1/subtitles/file', () => {
        const raw =
            'https://dl.opensubtitles.org/en/download/subencoding-utf8/file/1';
        const wrapped = `https://core.cineflix.dev/v1/subtitles/file?url=${encodeURIComponent(raw)}`;
        assert.equal(normalizeSubtitleDownloadUrl(wrapped), raw);
        assert.equal(unwrapSubtitleUpstream(wrapped), raw);
    });

    it('keeps vdrk-style /v1/proxy links', () => {
        const vdrk =
            'https://core.cineflix.dev/v1/proxy?data=%7B%22url%22%3A%22https%3A%2F%2Fcache.vdrk.site%2Fa.vtt%22%7D';
        assert.equal(createSubtitleProxyUrl(vdrk), vdrk);
        assert.equal(normalizeSubtitleDownloadUrl(vdrk), vdrk);
    });

    it('unwraps OS links still on /v1/proxy into raw CDN', () => {
        const inner =
            'https://dl.opensubtitles.org/en/download/subencoding-utf8/file/9';
        const bad =
            'https://core.cineflix.dev/v1/proxy?data=' +
            encodeURIComponent(JSON.stringify({ url: inner }));
        const out = createSubtitleProxyUrl(bad);
        assert.equal(out, inner);
        assert.ok(!out.includes('/v1/subtitles/file'));
        assert.ok(!out.includes('/v1/proxy?'));
    });

    it('proxySubtitleUrls maps list to raw OS URLs', () => {
        const out = proxySubtitleUrls([
            {
                url: 'https://dl.opensubtitles.org/en/download/file/1',
                label: 'en'
            }
        ]);
        assert.equal(
            out[0]!.url,
            'https://dl.opensubtitles.org/en/download/file/1'
        );
        assert.ok(!out[0]!.url.includes('/v1/subtitles/file'));
    });
});
