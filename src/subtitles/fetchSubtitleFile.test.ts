/**
 * Run: npx tsx --test src/subtitles/fetchSubtitleFile.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    isBotChallengeHtml,
    isOpenSubtitlesLoginWall,
    looksLikeSubtitle
} from './fetchSubtitleFile.js';

describe('subtitle body detection', () => {
    it('accepts WEBVTT and SRT', () => {
        assert.equal(
            looksLikeSubtitle(
                'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n'
            ),
            true
        );
        assert.equal(
            looksLikeSubtitle(
                '1\n00:00:05,866 --> 00:00:30,866\nHello\n'
            ),
            true
        );
    });

    it('accepts microDVD frame format', () => {
        assert.equal(
            looksLikeSubtitle('{1}{72}Hello world\n{97}{247}Line two\n'),
            true
        );
    });

    it('rejects Anubis / rewritten proxy garbage', () => {
        assert.equal(
            isBotChallengeHtml(
                '<!DOCTYPE html><html>Making sure you\'re not a bot Anubis challenge'
            ),
            true
        );
        assert.equal(
            looksLikeSubtitle(
                '/v1/proxy?data=%7B%22url%22%3A%22https%3A%2F%2Fdl.opensubtitles.org'
            ),
            false
        );
        assert.equal(
            looksLikeSubtitle('<!DOCTYPE html><html lang="en">'),
            false
        );
    });

    it('rejects OpenSubtitles login-wall fake SRT', () => {
        const wall = `1
00:00:00,001 --> 04:00:00,000
In order to continue OpenSubtitles.org
subtitles service you need to Log In
`;
        assert.equal(isOpenSubtitlesLoginWall(wall), true);
        assert.equal(looksLikeSubtitle(wall), false);
    });
});
