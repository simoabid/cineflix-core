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

describe('subtitle proxy URL rewrite', () => {
    beforeEach(() => {
        process.env.PUBLIC_URL = 'https://core.cineflix.dev';
        delete process.env.HOST;
        delete process.env.PORT;
    });

    it('builds absolute /v1/proxy links from PUBLIC_URL', () => {
        assert.equal(getProxyBaseUrl(), 'https://core.cineflix.dev');
        const u = createSubtitleProxyUrl('https://cdn.example/en.srt');
        assert.ok(u.startsWith('https://core.cineflix.dev/v1/proxy?data='));
        const data = JSON.parse(
            decodeURIComponent(new URL(u).searchParams.get('data')!)
        );
        assert.equal(data.url, 'https://cdn.example/en.srt');
    });

    it('uses TemporaryUserAgent for OpenSubtitles hosts', () => {
        const u = createSubtitleProxyUrl(
            'https://dl.opensubtitles.org/en/download/file/1'
        );
        const data = JSON.parse(
            decodeURIComponent(new URL(u).searchParams.get('data')!)
        );
        assert.equal(data.headers['User-Agent'], 'TemporaryUserAgent');
    });

    it('rewrites lists and skips already-proxied urls', () => {
        const already =
            'https://core.cineflix.dev/v1/proxy?data=%7B%22url%22%3A%22x%22%7D';
        const out = proxySubtitleUrls([
            { url: 'https://cdn.example/a.srt', label: 'A' },
            { url: already, label: 'B' }
        ]);
        assert.ok(out[0]!.url.includes('/v1/proxy?data='));
        assert.equal(out[1]!.url, already);
    });
});
