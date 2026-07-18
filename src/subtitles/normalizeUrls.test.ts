/**
 * Run: npx tsx --test src/subtitles/normalizeUrls.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    isOpenSubtitlesUrl,
    normalizeSubtitleDownloadUrl,
    normalizeSubtitleUrls,
    resolveProviderSubtitleUrl,
    unwrapSubtitleUpstream
} from './normalizeUrls.js';

describe('normalizeSubtitleDownloadUrl', () => {
    it('keeps raw OpenSubtitles URLs', () => {
        const raw =
            'https://dl.opensubtitles.org/en/download/subencoding-utf8/file/1';
        assert.equal(isOpenSubtitlesUrl(raw), true);
        assert.equal(normalizeSubtitleDownloadUrl(raw), raw);
    });

    it('unwraps legacy /v1/subtitles/file wrappers', () => {
        const raw =
            'https://dl.opensubtitles.org/en/download/subencoding-utf8/file/1';
        const wrapped = `https://core.cineflix.dev/v1/subtitles/file?url=${encodeURIComponent(raw)}`;
        assert.equal(normalizeSubtitleDownloadUrl(wrapped), raw);
        assert.equal(unwrapSubtitleUpstream(wrapped), raw);
    });

    it('unwraps OpenSubtitles stuck on /v1/proxy', () => {
        const inner =
            'https://dl.opensubtitles.org/en/download/subencoding-utf8/file/9';
        const bad =
            'https://core.cineflix.dev/v1/proxy?data=' +
            encodeURIComponent(JSON.stringify({ url: inner }));
        assert.equal(normalizeSubtitleDownloadUrl(bad), inner);
    });

    it('keeps non-OS /v1/proxy (e.g. vdrk VTT)', () => {
        const vdrk =
            'https://core.cineflix.dev/v1/proxy?data=%7B%22url%22%3A%22https%3A%2F%2Fcache.vdrk.site%2Fa.vtt%22%7D';
        assert.equal(normalizeSubtitleDownloadUrl(vdrk), vdrk);
    });

    it('maps lists', () => {
        const out = normalizeSubtitleUrls([
            { url: 'https://dl.opensubtitles.org/en/download/file/1', label: 'en' }
        ]);
        assert.equal(
            out[0]!.url,
            'https://dl.opensubtitles.org/en/download/file/1'
        );
    });

    it('resolveProviderSubtitleUrl skips proxy for OpenSubtitles', () => {
        const raw = 'https://dl.opensubtitles.org/en/download/file/1';
        const proxied = resolveProviderSubtitleUrl(
            raw,
            (u) => `https://core/v1/proxy?data=${encodeURIComponent(JSON.stringify({ url: u }))}`
        );
        assert.equal(proxied, raw);
    });

    it('resolveProviderSubtitleUrl proxies non-OS hosts', () => {
        const raw = 'https://cdn.example.com/a.vtt';
        const proxied = resolveProviderSubtitleUrl(
            raw,
            (u) => `PROXY:${u}`
        );
        assert.equal(proxied, 'PROXY:https://cdn.example.com/a.vtt');
    });
});
