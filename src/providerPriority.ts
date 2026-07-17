/**
 * CinePro provider scrape priority (best → worst).
 *
 * Keep roughly in sync with frontend `src/config/scrapePriority.ts`.
 * Derived from EC2 diagnostic test-all (reliability + latency).
 *
 * Tiers:
 *   S — fast + reliable both media
 *   A — solid when up (some partials)
 *   B — works but slow / partial
 *   C — flaky (proxy IP, etc.)
 */

export type ProviderTier = 'S' | 'A' | 'B' | 'C';

export type ProviderPriorityEntry = {
    id: string;
    tier: ProviderTier;
    /** Soft per-request timeout for progressive single-provider scrapes (ms). */
    timeoutMs: number;
};

/** Ordered best-first for progressive waterfall. */
export const CINEPRO_PROVIDER_PRIORITY: readonly ProviderPriorityEntry[] = [
    // S-tier
    { id: 'vidup', tier: 'S', timeoutMs: 8_000 },
    { id: 'vidlink', tier: 'S', timeoutMs: 10_000 },
    { id: 'vidsrc', tier: 'S', timeoutMs: 12_000 },
    { id: 'hexa', tier: 'S', timeoutMs: 15_000 },
    // A-tier
    { id: 'm111movies', tier: 'A', timeoutMs: 15_000 },
    { id: 'fsharetv', tier: 'A', timeoutMs: 12_000 },
    { id: 'lookmovie', tier: 'A', timeoutMs: 15_000 },
    { id: 'vidrock', tier: 'A', timeoutMs: 12_000 },
    { id: 'vidcore', tier: 'A', timeoutMs: 15_000 },
    { id: 'Icefy', tier: 'A', timeoutMs: 12_000 },
    // B-tier (slow / partial)
    { id: 'Peachify', tier: 'B', timeoutMs: 15_000 },
    { id: 'vidnest', tier: 'B', timeoutMs: 18_000 },
    { id: 'vidking', tier: 'B', timeoutMs: 18_000 },
    { id: 'Videasy', tier: 'B', timeoutMs: 20_000 },
    // C-tier (flaky)
    { id: 'vixsrc', tier: 'C', timeoutMs: 12_000 }
] as const;

const priorityIndex = new Map(
    CINEPRO_PROVIDER_PRIORITY.map((e, i) => [e.id, i] as const)
);

const tierById = new Map(
    CINEPRO_PROVIDER_PRIORITY.map((e) => [e.id, e.tier] as const)
);

const timeoutById = new Map(
    CINEPRO_PROVIDER_PRIORITY.map((e) => [e.id, e.timeoutMs] as const)
);

export function getProviderPriorityIndex(id: string): number {
    return priorityIndex.get(id) ?? 10_000;
}

export function getProviderTier(id: string): ProviderTier | null {
    return tierById.get(id) ?? null;
}

export function getProviderTimeoutMs(id: string, fallback = 15_000): number {
    return timeoutById.get(id) ?? fallback;
}

/**
 * Sort provider ids best-first. Unknown ids sort after known ones,
 * preserving relative order among unknowns.
 */
export function sortProviderIdsByPriority(ids: string[]): string[] {
    return [...ids].sort((a, b) => {
        const ia = getProviderPriorityIndex(a);
        const ib = getProviderPriorityIndex(b);
        if (ia !== ib) return ia - ib;
        return a.localeCompare(b);
    });
}

/** Default progressive order for enabled providers only. */
export function orderedEnabledProviderIds(
    providers: Array<{ id: string; enabled: boolean }>
): string[] {
    const enabled = providers.filter((p) => p.enabled).map((p) => p.id);
    return sortProviderIdsByPriority(enabled);
}
