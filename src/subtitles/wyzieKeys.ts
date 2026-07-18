/**
 * Multi-key pool for Wyzie free-tier accounts (1k req/day each).
 *
 * Env (comma / whitespace / newline separated):
 *   WYZIE_API_KEYS=wyzie-key1,wyzie-key2,wyzie-key3
 *   WYZIE_API_KEY=wyzie-key1   # single-key alias
 *
 * Keys stay on the server only — never expose via VITE_* or client bundles.
 */

export type WyzieKeyFailureReason = 'auth' | 'rate_limit' | 'error';

/** How long a key stays cool after failure (ms). */
const COOLDOWN_MS: Record<WyzieKeyFailureReason, number> = {
    auth: 60 * 60 * 1000, // 1h — bad/revoked key
    rate_limit: 15 * 60 * 1000, // 15m — daily quota or 429
    error: 2 * 60 * 1000 // 2m — transient
};

type KeyState = {
    key: string;
    /** Unix ms until which this key is skipped */
    coolUntil: number;
    consecutiveFailures: number;
};

let states: KeyState[] = [];
let cursor = 0;

function parseKeysFromEnv(): string[] {
    const raw =
        process.env.WYZIE_API_KEYS?.trim() ||
        process.env.WYZIE_API_KEY?.trim() ||
        '';
    if (!raw) return [];
    return [
        ...new Set(
            raw
                .split(/[\s,;]+/)
                .map((k) => k.trim())
                .filter((k) => k.length > 0)
        )
    ];
}

function ensureLoaded(): void {
    const keys = parseKeysFromEnv();
    if (states.length === 0 && keys.length > 0) {
        states = keys.map((key) => ({
            key,
            coolUntil: 0,
            consecutiveFailures: 0
        }));
        cursor = 0;
        return;
    }
    // Hot-reload env additions without dropping cooldown on known keys
    if (keys.length > 0) {
        const known = new Set(states.map((s) => s.key));
        for (const key of keys) {
            if (!known.has(key)) {
                states.push({ key, coolUntil: 0, consecutiveFailures: 0 });
            }
        }
        // Drop keys removed from env
        states = states.filter((s) => keys.includes(s.key));
        if (cursor >= states.length) cursor = 0;
    }
}

/** Number of configured keys (any state). */
export function wyzieKeyCount(): number {
    ensureLoaded();
    return states.length;
}

/** Masked summary for logs — never prints full secrets. */
export function wyzieKeyPoolSummary(): string {
    ensureLoaded();
    if (states.length === 0) return '0 keys configured';
    const now = Date.now();
    const ready = states.filter((s) => s.coolUntil <= now).length;
    return `${states.length} key(s), ${ready} ready`;
}

/**
 * Pick next usable key (round-robin, skip cooled). Returns null if none ready.
 */
export function pickWyzieKey(): string | null {
    ensureLoaded();
    if (states.length === 0) return null;
    const now = Date.now();
    for (let i = 0; i < states.length; i++) {
        const idx = (cursor + i) % states.length;
        const s = states[idx]!;
        if (s.coolUntil <= now) {
            cursor = (idx + 1) % states.length;
            return s.key;
        }
    }
    return null;
}

/** Mark key failed and apply cooldown so rotation skips it. */
export function markWyzieKeyFailed(
    key: string,
    reason: WyzieKeyFailureReason
): void {
    ensureLoaded();
    const s = states.find((x) => x.key === key);
    if (!s) return;
    s.consecutiveFailures += 1;
    const base = COOLDOWN_MS[reason];
    // Back off further on repeated failures
    const mult = Math.min(4, 1 + Math.floor(s.consecutiveFailures / 2));
    s.coolUntil = Date.now() + base * mult;
}

/** Clear failure streak after a successful response. */
export function markWyzieKeySuccess(key: string): void {
    ensureLoaded();
    const s = states.find((x) => x.key === key);
    if (!s) return;
    s.consecutiveFailures = 0;
    s.coolUntil = 0;
}

/** Test helper — reset pool state. */
export function resetWyzieKeyPoolForTests(): void {
    states = [];
    cursor = 0;
}
