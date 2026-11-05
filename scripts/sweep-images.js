// Deletes images that no product / category / logo references any more (leftovers of failed saves).
//   node scripts/sweep-images.js                 -> dry run (lists only)
//   node scripts/sweep-images.js --apply         -> deletes
//   node scripts/sweep-images.js --min-age-hours=48
import { loadConfig } from '../src/config.js';
import { initAdmin } from '../src/firebase.js';
import { createImageStore } from '../src/storage.js';
import { collectReferencedKeys } from '../src/references.js';
import { sweepImages } from '../src/sweep.js';

const apply = process.argv.includes('--apply');
const ageArg = process.argv.find((a) => a.startsWith('--min-age-hours='));
const minAgeMs = (ageArg ? Number(ageArg.split('=')[1]) : 24) * 3600 * 1000;
if (!Number.isFinite(minAgeMs) || minAgeMs < 3600 * 1000) {
  console.error('--min-age-hours must be a number >= 1');
  process.exit(1);
}

const cfg = loadConfig();
const { db } = initAdmin(cfg);
const result = await sweepImages({
  imageStore: createImageStore(cfg),
  referenced: await collectReferencedKeys(db),
  apply,
  minAgeMs,
});
console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: scanned ${result.scanned}, orphans ${result.orphans.length}, deleted ${result.deleted}`);
for (const k of result.orphans) console.log(' -', k);
if (!apply && result.orphans.length) console.log('Re-run with --apply to delete them.');
