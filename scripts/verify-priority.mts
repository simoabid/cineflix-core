/**
 * Structural + pure-function verification for core progressive scrape modules.
 * Run: npx tsx scripts/verify-priority.mts
 */
import {
    CINEPRO_PROVIDER_PRIORITY,
    sortProviderIdsByPriority,
    orderedEnabledProviderIds,
    getProviderPriorityIndex
} from '../src/providerPriority.ts';

const failures: string[] = [];

function assert(cond: boolean, msg: string) {
    if (!cond) failures.push(msg);
}

// Best-first: first entry must have lower index than last
assert(CINEPRO_PROVIDER_PRIORITY.length >= 4, 'priority list has tiers');
assert(
    CINEPRO_PROVIDER_PRIORITY[0]!.id === 'vidup',
    'first priority is vidup (S-tier)'
);
assert(
    CINEPRO_PROVIDER_PRIORITY[CINEPRO_PROVIDER_PRIORITY.length - 1]!.id ===
        'vixsrc',
    'last priority is vixsrc (C-tier)'
);

const shuffled = ['vixsrc', 'hexa', 'vidup', 'Peachify'];
const ordered = sortProviderIdsByPriority(shuffled);
assert(ordered[0] === 'vidup', `ordered[0]=${ordered[0]} expected vidup`);
assert(
    getProviderPriorityIndex(ordered[0]!) <
        getProviderPriorityIndex(ordered[ordered.length - 1]!),
    'sort places better before worse'
);

const enabledOnly = orderedEnabledProviderIds([
    { id: 'vidup', enabled: true },
    { id: 'hexa', enabled: false },
    { id: 'vixsrc', enabled: true }
]);
assert(!enabledOnly.includes('hexa'), 'disabled providers excluded');
assert(enabledOnly[0] === 'vidup', 'enabled list still priority-ordered');

if (failures.length) {
    console.error('FAIL');
    for (const f of failures) console.error(' -', f);
    process.exit(1);
}
console.log('PASS core providerPriority pure checks');
console.log(
    'order sample:',
    sortProviderIdsByPriority(['Videasy', 'vidsrc', 'lookmovie']).join(' > ')
);
