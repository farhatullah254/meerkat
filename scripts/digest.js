import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/paths.js';
import { loadSites } from '../lib/config.js';
import { buildDigest } from '../lib/digest.js';

let sites;
try {
  sites = loadSites();
} catch (err) {
  console.error(`\n  ✗ ${err.message}\n`);
  process.exit(1);
}

const now = new Date();
const stamp = now.toISOString().slice(0, 10);
const markdown = buildDigest(sites, now.toISOString().replace('T', ' ').slice(0, 16));

const dir = path.join(DATA_DIR, 'digests');
mkdirSync(dir, { recursive: true });

const dated = path.join(dir, `${stamp}.md`);
const latest = path.join(dir, 'latest.md');
writeFileSync(dated, `${markdown}\n`);
writeFileSync(latest, `${markdown}\n`);

const kb = (markdown.length / 1024).toFixed(1);
console.log(`\n  ${dated}`);
console.log(`  ${latest}`);
console.log(`\n  ${kb} KB · ${markdown.split('\n').length} lines\n`);
