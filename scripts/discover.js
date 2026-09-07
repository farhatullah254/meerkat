import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/paths.js';
import { getServiceAccountEmail } from '../lib/auth.js';
import { buildSites } from '../lib/discover.js';

/**
 * Asks Google what this service account can see and writes config.json from
 * the answer. Run it after granting access, and again whenever you add a site.
 */

const CONFIG = path.join(ROOT, 'config.json');
const apply = process.argv.includes('--write');

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
  result = await buildSites();
} catch (err) {
  console.error(`  ✗ Discovery failed: ${err.message}\n`);
  if (err.body?.error?.details?.[0]?.metadata?.activationUrl) {
    console.error(`  Enable the API here:\n  ${err.body.error.details[0].metadata.activationUrl}\n`);
  }
  process.exit(1);
}

const { sites, properties, gscSites } = result;

console.log(`GA4 properties visible:          ${properties.length}`);
console.log(`Search Console sites visible:    ${gscSites.length}\n`);

if (sites.length === 0) {
  console.log('  Nothing found. The service account has not been granted access to anything yet.\n');
  console.log(`  GA4:  Admin → Property Access Management → add ${email} as Viewer`);
  console.log(`  GSC:  Settings → Users and permissions → add ${email} as Restricted\n`);
  process.exit(1);
}

for (const s of sites) {
  const flag = s._gscOnly ? 'GSC only' : s._matched ? 'GA4 + GSC' : 'GA4 only';
  console.log(`  ${s.name}`);
  console.log(`      ${flag}`);
  if (s.ga4PropertyId) console.log(`      GA4  ${s.ga4PropertyId}${s._account ? `  (${s._account})` : ''}`);
  if (s.gscSite) console.log(`      GSC  ${s.gscSite}`);
  if (s.url) console.log(`      URL  ${s.url}`);
  if (!s.gscSite) console.log(`      ! no Search Console match — add it in GSC, or set gscSite by hand`);
  if (!s.ga4PropertyId) console.log(`      ! no GA4 match — this card will show search data only`);
  console.log('');
}

// Preserve anything you hand-tuned: custom names and per-site thresholds
// survive a re-run, keyed on the GA4 property ID.
let previous = [];
if (existsSync(CONFIG)) {
  try {
    previous = JSON.parse(readFileSync(CONFIG, 'utf8')).sites ?? [];
  } catch {
    console.log('  (existing config.json is unreadable; it will be replaced)\n');
  }
}

const byId = new Map(previous.filter((s) => s.ga4PropertyId).map((s) => [String(s.ga4PropertyId), s]));
const byGsc = new Map(previous.filter((s) => s.gscSite).map((s) => [s.gscSite, s]));

const merged = sites.map((s) => {
  const old = byId.get(String(s.ga4PropertyId)) ?? byGsc.get(s.gscSite) ?? null;
  const out = {
    name: old?.name ?? s.name,
    ga4PropertyId: s.ga4PropertyId ?? undefined,
    gscSite: s.gscSite ?? undefined,
    url: old?.url ?? s.url ?? undefined,
  };
  if (old?.thresholds) out.thresholds = old.thresholds;
  return JSON.parse(JSON.stringify(out));
});

const output = JSON.stringify({ sites: merged }, null, 2);

if (!apply) {
  console.log('─'.repeat(60));
  console.log('Preview only. Re-run with --write to save this to config.json:\n');
  console.log(output);
  console.log('');
  process.exit(0);
}

if (existsSync(CONFIG)) {
  copyFileSync(CONFIG, `${CONFIG}.bak`);
  console.log('Existing config.json backed up to config.json.bak');
}

writeFileSync(CONFIG, `${output}\n`);
console.log(`Wrote ${merged.length} sites to config.json\n`);
console.log('Next:  npm run check\n');
