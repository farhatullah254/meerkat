import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';

const CONFIG_PATH = path.join(ROOT, 'config.json');

export function loadSites() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `config.json not found. Copy config.example.json to config.json and add your sites.`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }

  const sites = parsed.sites;
  if (!Array.isArray(sites) || sites.length === 0) {
    throw new Error(`config.json must contain a non-empty "sites" array.`);
  }

  sites.forEach((s, i) => {
    if (!s.name) throw new Error(`config.json: site #${i + 1} is missing "name".`);
    if (!s.ga4PropertyId && !s.gscSite) {
      throw new Error(`config.json: "${s.name}" needs at least a ga4PropertyId or a gscSite.`);
    }
    if (s.ga4PropertyId && !/^\d+$/.test(String(s.ga4PropertyId))) {
      throw new Error(
        `config.json: "${s.name}" has ga4PropertyId "${s.ga4PropertyId}". ` +
          `That should be the numeric property ID from GA4 Admin, not a G-XXXX measurement ID.`
      );
    }
  });

  const names = sites.map((s) => s.name);
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe) throw new Error(`config.json: duplicate site name "${dupe}".`);

  return sites;
}
