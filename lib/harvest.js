import { fetchQueryRows, fetchPageRows } from './gsc.js';
import { fetchDimensional } from './ga4.js';
import { fetchSitemapUrls } from './sitemap.js';
import { inspectUrls, isIndexed } from './inspect.js';
import { isUtilityPage } from './insights.js';
import { snapshotRanks } from './ranks.js';
import { upsertMany, recordHarvest, query } from './history.js';

/** GA4 returns YYYYMMDD; Search Console returns YYYY-MM-DD. Store one shape. */
function isoDate(ga4Date) {
  return `${ga4Date.slice(0, 4)}-${ga4Date.slice(4, 6)}-${ga4Date.slice(6, 8)}`;
}

async function step(site, kind, fn, onLog) {
  try {
    const rows = await fn();
    recordHarvest(site.name, kind, rows);
    onLog?.(`    ${kind}: ${rows} rows`);
    return rows;
  } catch (err) {
    recordHarvest(site.name, kind, 0, err.message);
    onLog?.(`    ${kind}: failed — ${err.message}`);
    return 0;
  }
}

/**
 * Pull dimensional data for one site.
 *
 * `days` defaults to 28 — Search Console's full retention for a first run.
 * Daily runs re-pull the same window on purpose: Google revises recent days
 * upward for about 48 hours, and the primary keys turn that into an update.
 */
export async function harvestSite(site, days = 28, onLog) {
  onLog?.(`  ${site.name.trim()}`);
  let total = 0;

  if (site.gscSite) {
    total += await step(site, 'gsc_queries', async () => {
      const rows = await fetchQueryRows(site.gscSite, days);
      return upsertMany(
        'gsc_queries',
        rows.map((r) => [site.name, r.keys[0], r.keys[1], r.clicks, r.impressions, r.ctr, r.position])
      );
    }, onLog);

    total += await step(site, 'gsc_pages', async () => {
      const rows = await fetchPageRows(site.gscSite, days);
      return upsertMany(
        'gsc_pages',
        rows.map((r) => [site.name, r.keys[0], r.keys[1], r.clicks, r.impressions, r.ctr, r.position])
      );
    }, onLog);
  }

  if (site.gscSite) {
    total += await step(site, 'rank_tracking', async () => {
      const r = await snapshotRanks(site);
      onLog?.(`      tracking ${r.tracked} keywords`);
      return r.rows;
    }, onLog);
  }

  if (site.gscSite && site.url) {
    total += await step(site, 'url_inspection', async () => {
      const r = await inspectSite(site);
      if (r.noSitemap) {
        onLog?.(`      ! no sitemap found and no known pages`);
        return 0;
      }
      onLog?.(
        `      ${r.indexed}/${r.checked} content pages indexed` +
          (r.missing > 0 ? `, ${r.missing} not indexed` : '') +
          (r.skippedUtility > 0 ? `, ${r.skippedUtility} utility skipped` : '') +
          (r.skipped > 0 ? `, ${r.skipped} over cap` : '') +
          (r.errors > 0 ? `, ${r.errors} errors` : '')
      );
      return r.checked;
    }, onLog);
  }

  if (site.ga4PropertyId) {
    total += await step(site, 'ga4_dimensional', async () => {
      const d = await fetchDimensional(site.ga4PropertyId, days);
      let n = 0;
      n += upsertMany(
        'ga4_pages',
        d.pages.map((p) => [site.name, isoDate(p.date), p.path, p.sessions, p.users, p.views, p.engagementRate])
      );
      n += upsertMany(
        'ga4_countries',
        d.countries.map((c) => [site.name, isoDate(c.date), c.country, c.users, c.sessions])
      );
      n += upsertMany(
        'ga4_sources',
        d.sources.map((s) => [site.name, isoDate(s.date), s.source, s.medium, s.sessions])
      );
      return n;
    }, onLog);
  }

  return total;
}

/**
 * Inspect every URL in the site's sitemap.
 *
 * Deliberately driven by the sitemap rather than by pages we already have
 * performance data for: a page that was never indexed has no impressions, so
 * it never appears in the performance report. The sitemap is the only list
 * that includes the pages you most need to hear about.
 */
export async function inspectSite(site, { max = 200 } = {}) {
  if (!site.gscSite || !site.url) return { checked: 0, indexed: 0, missing: 0 };

  const { urls } = await fetchSitemapUrls(site.url);

  // Fall back to pages Search Console has seen, so a site with a broken or
  // missing sitemap still gets checked.
  const all = urls.length > 0
    ? urls
    : query(`SELECT DISTINCT page FROM gsc_pages WHERE site = ?`, site.name).map((r) => r.page);

  // Legal boilerplate — about, contact, dmca, privacy, terms — is skipped
  // entirely. Nobody searches for it, so whether Google indexed it carries no
  // information, and including it buried the real content gaps under a pile of
  // privacy policies. Set INSPECT_UTILITY_PAGES=1 to check them anyway.
  const list = process.env.INSPECT_UTILITY_PAGES === '1'
    ? all
    : all.filter((u) => !isUtilityPage(u));

  const skippedUtility = all.length - list.length;

  if (list.length === 0) {
    return { checked: 0, indexed: 0, missing: 0, skippedUtility, noSitemap: all.length === 0 };
  }

  const { results, errors, skipped } = await inspectUrls(site.gscSite, list, { max });
  const today = new Date().toISOString().slice(0, 10);

  upsertMany(
    'url_inspections',
    results.map((r) => [
      site.name, r.url, Date.now(), isIndexed(r) ? 1 : 0, r.verdict, r.coverageState,
      r.robotsTxtState, r.indexingState, r.pageFetchState, r.lastCrawlTime,
      r.googleCanonical, r.userCanonical, r.canonicalMismatch ? 1 : 0,
      r.sitemaps, r.richResultsVerdict, r.richResultsIssues, r.inspectionLink,
    ])
  );

  upsertMany(
    'url_inspection_history',
    results.map((r) => [site.name, r.url, today, isIndexed(r) ? 1 : 0, r.coverageState])
  );

  const indexed = results.filter(isIndexed).length;
  return {
    checked: results.length,
    indexed,
    missing: results.length - indexed,
    sitemapUrls: urls.length,
    skippedUtility,
    skipped,
    errors: errors.length,
  };
}

export async function harvestAll(sites, days = 28, onLog) {
  let total = 0;
  // Sequential on purpose. Ten sites in parallel would burst the per-minute
  // quota on both APIs, and this runs once a day — speed buys nothing.
  for (const site of sites) {
    total += await harvestSite(site, days, onLog);
  }
  return total;
}
