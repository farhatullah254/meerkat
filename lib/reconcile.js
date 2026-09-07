import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';
import { buildSites } from './discover.js';

const CONFIG = path.join(ROOT, 'config.json');

/**
 * Bring config.json in line with what the service account can currently see.
 *
 * Append-only by design. A property that disappears from discovery is far more
 * likely to be a revoked grant, a renamed GSC property, or a transient API
 * error than a site you actually deleted — silently dropping it would throw
 * away its stored history. Removals stay a manual edit.
 */
export async function reconcile({ write = false } = {}) {
  const discovered = (await buildSites()).sites;

  let existing = [];
  if (existsSync(CONFIG)) {
    try {
      existing = JSON.parse(readFileSync(CONFIG, 'utf8')).sites ?? [];
    } catch {
      existing = [];
    }
  }

  const byGa4 = new Map(existing.filter((s) => s.ga4PropertyId).map((s) => [String(s.ga4PropertyId), s]));
  const byGsc = new Map(existing.filter((s) => s.gscSite).map((s) => [s.gscSite, s]));

  const added = [];
  const enriched = [];

  for (const d of discovered) {
    const match =
      (d.ga4PropertyId && byGa4.get(String(d.ga4PropertyId))) ||
      (d.gscSite && byGsc.get(d.gscSite)) ||
      null;

    if (!match) {
      added.push({
        name: d.name,
        ...(d.ga4PropertyId ? { ga4PropertyId: d.ga4PropertyId } : {}),
        ...(d.gscSite ? { gscSite: d.gscSite } : {}),
        ...(d.url ? { url: d.url } : {}),
      });
      continue;
    }

    // An existing site that has since gained the other half of its pairing —
    // a GA4-only site that now has Search Console, or the reverse.
    if (d.gscSite && !match.gscSite) {
      match.gscSite = d.gscSite;
      enriched.push(`${match.name.trim()}: linked ${d.gscSite}`);
    }
    if (d.ga4PropertyId && !match.ga4PropertyId) {
      match.ga4PropertyId = d.ga4PropertyId;
      enriched.push(`${match.name.trim()}: linked GA4 ${d.ga4PropertyId}`);
    }
    if (!match.url && d.url) match.url = d.url;
  }

  const changed = added.length > 0 || enriched.length > 0;
  const sites = [...existing, ...added];

  if (changed && write) {
    if (existsSync(CONFIG)) copyFileSync(CONFIG, `${CONFIG}.bak`);
    writeFileSync(CONFIG, `${JSON.stringify({ sites }, null, 2)}\n`);
  }

  return { added, enriched, changed, sites, total: sites.length };
}
