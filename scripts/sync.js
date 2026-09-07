import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/paths.js';
import { reconcile } from '../lib/reconcile.js';
import { loadSites } from '../lib/config.js';
import { harvestSite, harvestAll } from '../lib/harvest.js';
import { buildDigest } from '../lib/digest.js';
import { getServiceAccountEmail } from '../lib/auth.js';

/**
 * One command to bring everything up to date after adding a site:
 * find it, add it to the config, pull its history, rebuild the digest.
 */

const dryRun = process.argv.includes('--dry-run');
const skipHarvest = process.argv.includes('--no-harvest');

let email;
try {
  email = getServiceAccountEmail();
} catch (err) {
  console.error(`\n  ✗ ${err.message}\n`);
  process.exit(1);
}

console.log(`\nService account: ${email}\n`);

let result;
try {
  result = await reconcile({ write: !dryRun });
} catch (err) {
  console.error(`  ✗ Discovery failed: ${err.message}\n`);
  if (err.body?.error?.details?.[0]?.metadata?.activationUrl) {
    console.error(`  Enable the API here:\n  ${err.body.error.details[0].metadata.activationUrl}\n`);
  }
  process.exit(1);
}

if (!result.changed) {
  console.log(`No changes — ${result.total} sites already configured.\n`);
} else {
  for (const s of result.added) {
    console.log(`  + ${s.name.trim()}`);
    if (s.ga4PropertyId) console.log(`      GA4  ${s.ga4PropertyId}`);
    if (s.gscSite) console.log(`      GSC  ${s.gscSite}`);
    if (!s.gscSite) console.log(`      ! no Search Console property — add the service account there too`);
    if (!s.ga4PropertyId) console.log(`      ! no GA4 property — search data only`);
  }
  for (const line of result.enriched) console.log(`  ~ ${line}`);
  console.log('');

  if (!dryRun) {
    console.log(`config.json updated — ${result.total} sites (previous version in config.json.bak)\n`);
  }
}

// A dry run must not touch anything, including the harvest and the digest —
// checked here rather than inside the branch above so it also holds when
// discovery found nothing to change.
if (dryRun) {
  console.log('Dry run — nothing written. Re-run without --dry-run to apply.\n');
  process.exit(0);
}

if (skipHarvest) process.exit(0);

const sites = loadSites();

// Only the new sites need a backfill; everything else is already current.
const targets = result.added.length > 0
  ? sites.filter((s) => result.added.some((a) => a.name === s.name))
  : sites;

console.log(
  result.added.length > 0
    ? `Backfilling ${targets.length} new site(s)…\n`
    : `Refreshing all ${targets.length} sites…\n`
);

if (result.added.length > 0) {
  for (const site of targets) await harvestSite(site, 28, (l) => console.log(l));
} else {
  await harvestAll(targets, 28, (l) => console.log(l));
}

const now = new Date();
const markdown = buildDigest(sites, now.toISOString().replace('T', ' ').slice(0, 16));
const dir = path.join(DATA_DIR, 'digests');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, `${now.toISOString().slice(0, 10)}.md`), `${markdown}\n`);
writeFileSync(path.join(dir, 'latest.md'), `${markdown}\n`);

console.log(`\nDigest rebuilt → data/digests/latest.md\n`);
