import 'dotenv/config';
import { loadSites } from '../lib/config.js';
import { getServiceAccountEmail } from '../lib/auth.js';
import { fetchRealtime } from '../lib/ga4.js';
import { fetchSearchConsole } from '../lib/gsc.js';
import { checkSite } from '../lib/health.js';

/**
 * Run this after wiring up permissions. It tells you exactly which of the
 * 20-odd access grants you missed, instead of leaving you to guess from a
 * dashboard full of empty cards.
 */

let sites;
try {
  sites = loadSites();
  console.log(`\nService account: ${getServiceAccountEmail()}`);
} catch (err) {
  console.error(`\n  ✗ ${err.message}\n`);
  process.exit(1);
}

console.log(`Checking ${sites.length} sites…\n`);

let failures = 0;

for (const site of sites) {
  console.log(site.name);

  if (site.ga4PropertyId) {
    try {
      const n = await fetchRealtime(site.ga4PropertyId);
      console.log(`   ✓ GA4 ${site.ga4PropertyId} — ${n} active now`);
    } catch (err) {
      failures++;
      console.log(`   ✗ GA4 ${site.ga4PropertyId} — ${err.message}`);
      if (err.status === 403) {
        console.log(`     → Add ${getServiceAccountEmail()} as a Viewer in GA4 Property Access Management.`);
      }
    }
  } else {
    console.log('   · GA4 not configured');
  }

  if (site.gscSite) {
    try {
      const r = await fetchSearchConsole(site.gscSite);
      const h = r.hourlyAvailable ? `${r.clicks24h} clicks/24h` : '24h data unavailable';
      console.log(`   ✓ GSC ${site.gscSite} — ${h}, ${r.clicks7d} clicks/7d`);
    } catch (err) {
      failures++;
      console.log(`   ✗ GSC ${site.gscSite} — ${err.message}`);
      if (err.status === 403) {
        console.log(`     → Add ${getServiceAccountEmail()} under Settings → Users and permissions.`);
      }
      if (err.status === 404) {
        console.log(`     → Property string must match GSC exactly: "sc-domain:example.com" or "https://example.com/".`);
      }
    }
  } else {
    console.log('   · GSC not configured');
  }

  if (site.url) {
    const h = await checkSite(site.url);
    if (h.ok) {
      console.log(`   ✓ HTTP ${site.url} — ${h.status} in ${h.ms}ms`);
    } else {
      failures++;
      console.log(`   ✗ HTTP ${site.url} — ${h.error}`);
    }
  }

  console.log('');
}

console.log(failures === 0 ? 'All checks passed.\n' : `${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
