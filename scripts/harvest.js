import 'dotenv/config';
import { loadSites } from '../lib/config.js';
import { harvestAll } from '../lib/harvest.js';
import { getHarvestLog } from '../lib/history.js';

const daysArg = process.argv.find((a) => a.startsWith('--days='));
const days = daysArg ? Number(daysArg.split('=')[1]) : 28;

let sites;
try {
  sites = loadSites();
} catch (err) {
  console.error(`\n  ✗ ${err.message}\n`);
  process.exit(1);
}

console.log(`\nHarvesting ${days} days across ${sites.length} sites…\n`);

const started = Date.now();
const total = await harvestAll(sites, days, (line) => console.log(line));

console.log(`\n${total.toLocaleString()} rows in ${Math.round((Date.now() - started) / 1000)}s\n`);

const failures = getHarvestLog().filter((r) => r.error);
if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ${f.site} / ${f.kind}: ${f.error}`);
  console.log('');
}
