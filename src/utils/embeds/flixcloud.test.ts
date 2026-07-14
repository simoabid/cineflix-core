/**
 * flixcloud.test.ts — Standalone tester for the FlixCloud hoster resolver.
 * Run with: npx tsx src/utils/embeds/flixcloud.test.ts
 *
 * FlixCloud is a HOSTER (not a title catalogue), so this test resolves a
 * flixcloud.cc embed URL directly — the same input a source provider would
 * hand it via resolveFlixcloud(url). Embeds EXPIRE: if this returns null or
 * "could not find embedded data", grab a fresh flixcloud.cc/e/<id> URL from a
 * site that uses this hoster and set EMBED_URL below.
 */
import { resolveFlixcloud } from './flixcloud.js';

const EMBED_URL = 'https://flixcloud.cc/e/olygrhle7ty7?v=2';

async function main() {
    console.log(`=== Testing FlixCloud resolver ===\n${EMBED_URL}\n`);
    try {
        const result = await Promise.race([
            resolveFlixcloud(EMBED_URL),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Timeout (90s)')), 90_000)
            )
        ]);

        if (!result) {
            console.log(
                'Resolver returned null (embed expired, or upstream down). ' +
                    'Try a fresh flixcloud.cc/e/<id> URL in EMBED_URL.'
            );
            return;
        }

        console.log(
            `Streams: ${result.streams.length}, Subtitles: ${result.subtitles?.length ?? 0}`
        );
        for (const s of result.streams) {
            console.log(
                `  [${s.type}] ${s.quality ?? ''} — ${s.url.slice(0, 120)}...`
            );
        }
        for (const sub of result.subtitles ?? []) {
            console.log(`  <sub> ${sub.label} (${sub.format})`);
        }
    } catch (err) {
        console.log(
            'Resolver test failed:',
            err instanceof Error ? err.message : err
        );
    }
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
