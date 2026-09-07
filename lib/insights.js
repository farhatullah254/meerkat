import { query } from './history.js';

/**
 * Roughly what click-through rate a result earns at each position, from
 * published industry aggregates. Used only to spot outliers — a page earning
 * far less than its rank should is usually a title or snippet problem, which
 * is a much cheaper fix than trying to rank higher.
 */
const CTR_BY_POSITION = {
  1: 0.28, 2: 0.15, 3: 0.11, 4: 0.08, 5: 0.06,
  6: 0.05, 7: 0.04, 8: 0.034, 9: 0.029, 10: 0.025,
};

function expectedCtr(position) {
  const p = Math.round(position);
  if (p < 1) return CTR_BY_POSITION[1];
  if (p <= 10) return CTR_BY_POSITION[p];
  return Math.max(0.002, 0.025 * Math.pow(0.85, p - 10));
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'is', 'it',
  'with', 'my', 'me', 'you', 'your', 'how', 'what', 'best', 'com', 'www',
]);

/** Newest date we hold for a site, so windows follow the data, not the clock. */
function latestDate(table, site) {
  const row = query(`SELECT MAX(date) d FROM ${table} WHERE site = ?`, site)[0];
  return row?.d ?? null;
}

function daysBefore(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Queries ranking just off page one. The highest-leverage list in the whole
 * dashboard: these already have impressions, so a section of content or a
 * tightened title can move them into positions that actually get clicked.
 */
export function strikingDistance(site, { minImpressions = env('INSIGHT_MIN_IMPRESSIONS', 5), limit = 25 } = {}) {
  const end = latestDate('gsc_queries', site);
  if (!end) return [];
  const start = daysBefore(end, 27);

  return query(
    `SELECT query,
            SUM(clicks) clicks,
            SUM(impressions) impressions,
            SUM(position * impressions) / NULLIF(SUM(impressions), 0) position
     FROM gsc_queries
     WHERE site = ? AND date BETWEEN ? AND ?
     GROUP BY query
     HAVING impressions >= ? AND position > 7.5 AND position <= 20.5
     ORDER BY impressions DESC
     LIMIT ?`,
    site, start, end, minImpressions, limit
  ).map((r) => ({ ...r, position: round(r.position, 1) }));
}

/** Ranking well but under-clicked — almost always a title/snippet problem. */
export function ctrGaps(site, { minImpressions = env('INSIGHT_CTR_MIN_IMPRESSIONS', 15), limit = 20 } = {}) {
  const end = latestDate('gsc_queries', site);
  if (!end) return [];
  const start = daysBefore(end, 27);

  return query(
    `SELECT query,
            SUM(clicks) clicks,
            SUM(impressions) impressions,
            SUM(position * impressions) / NULLIF(SUM(impressions), 0) position
     FROM gsc_queries
     WHERE site = ? AND date BETWEEN ? AND ?
     GROUP BY query
     HAVING impressions >= ? AND position <= 10.5
     ORDER BY impressions DESC
     LIMIT 200`,
    site, start, end, minImpressions
  )
    .map((r) => {
      const actual = r.impressions > 0 ? r.clicks / r.impressions : 0;
      const target = expectedCtr(r.position);
      return {
        query: r.query,
        clicks: r.clicks,
        impressions: r.impressions,
        position: round(r.position, 1),
        ctr: round(actual * 100, 1),
        expectedCtr: round(target * 100, 1),
        missedClicks: Math.round((target - actual) * r.impressions),
      };
    })
    .filter((r) => r.missedClicks >= env('INSIGHT_MIN_MISSED_CLICKS', 2) && r.ctr < r.expectedCtr * 0.6)
    .sort((a, b) => b.missedClicks - a.missedClicks)
    .slice(0, limit);
}

/** Seen but never clicked — either wrong intent, or a listing nobody trusts. */
export function zeroClickQueries(site, { minImpressions = env('INSIGHT_MIN_IMPRESSIONS', 5) * 2, limit = 15 } = {}) {
  const end = latestDate('gsc_queries', site);
  if (!end) return [];
  const start = daysBefore(end, 27);

  return query(
    `SELECT query,
            SUM(impressions) impressions,
            SUM(position * impressions) / NULLIF(SUM(impressions), 0) position
     FROM gsc_queries
     WHERE site = ? AND date BETWEEN ? AND ?
     GROUP BY query
     HAVING SUM(clicks) = 0 AND impressions >= ?
     ORDER BY impressions DESC
     LIMIT ?`,
    site, start, end, minImpressions, limit
  ).map((r) => ({ ...r, position: round(r.position, 1) }));
}

/** Week-over-week query movement — what is gaining and what is slipping. */
export function queryMovement(site, { limit = 10 } = {}) {
  const end = latestDate('gsc_queries', site);
  if (!end) return { rising: [], falling: [] };

  const curStart = daysBefore(end, 6);
  const prevEnd = daysBefore(end, 7);
  const prevStart = daysBefore(end, 13);

  const rows = query(
    `SELECT q.query,
            COALESCE(cur.clicks, 0) cur_clicks,
            COALESCE(prev.clicks, 0) prev_clicks,
            COALESCE(cur.position, prev.position) position
     FROM (SELECT DISTINCT query FROM gsc_queries WHERE site = ? AND date BETWEEN ? AND ?) q
     LEFT JOIN (
       SELECT query, SUM(clicks) clicks,
              SUM(position * impressions) / NULLIF(SUM(impressions),0) position
       FROM gsc_queries WHERE site = ? AND date BETWEEN ? AND ? GROUP BY query
     ) cur ON cur.query = q.query
     LEFT JOIN (
       SELECT query, SUM(clicks) clicks,
              SUM(position * impressions) / NULLIF(SUM(impressions),0) position
       FROM gsc_queries WHERE site = ? AND date BETWEEN ? AND ? GROUP BY query
     ) prev ON prev.query = q.query`,
    site, prevStart, end, site, curStart, end, site, prevStart, prevEnd
  ).map((r) => ({
    query: r.query,
    current: r.cur_clicks,
    previous: r.prev_clicks,
    delta: r.cur_clicks - r.prev_clicks,
    position: round(r.position, 1),
  }));

  return {
    rising: rows.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, limit),
    falling: rows.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, limit),
  };
}

export function topPages(site, { limit = 10 } = {}) {
  const end = latestDate('gsc_pages', site);
  if (!end) return [];
  const start = daysBefore(end, 27);

  return query(
    `SELECT page, SUM(clicks) clicks, SUM(impressions) impressions,
            SUM(position * impressions) / NULLIF(SUM(impressions),0) position
     FROM gsc_pages WHERE site = ? AND date BETWEEN ? AND ?
     GROUP BY page ORDER BY clicks DESC, impressions DESC LIMIT ?`,
    site, start, end, limit
  ).map((r) => ({ ...r, position: round(r.position, 1) }));
}

/** Indexed, getting shown, earning nothing. Candidates for rewrite or merge. */
export function deadPages(site, { minImpressions = env('INSIGHT_MIN_IMPRESSIONS', 5) * 3, limit = 10 } = {}) {
  const end = latestDate('gsc_pages', site);
  if (!end) return [];
  const start = daysBefore(end, 27);

  return query(
    `SELECT page, SUM(impressions) impressions,
            SUM(position * impressions) / NULLIF(SUM(impressions),0) position
     FROM gsc_pages WHERE site = ? AND date BETWEEN ? AND ?
     GROUP BY page HAVING SUM(clicks) = 0 AND impressions >= ?
     ORDER BY impressions DESC LIMIT ?`,
    site, start, end, minImpressions, limit
  ).map((r) => ({ ...r, position: round(r.position, 1) }));
}

export function topCountries(site, { limit = 5 } = {}) {
  const end = latestDate('ga4_countries', site);
  if (!end) return [];
  const start = daysBefore(end, 27);

  return query(
    `SELECT country, SUM(sessions) sessions, SUM(users) users
     FROM ga4_countries WHERE site = ? AND date BETWEEN ? AND ?
     GROUP BY country ORDER BY sessions DESC LIMIT ?`,
    site, start, end, limit
  );
}

export function topLandingPages(site, { limit = 10 } = {}) {
  const end = latestDate('ga4_pages', site);
  if (!end) return [];
  const start = daysBefore(end, 27);

  return query(
    `SELECT path, SUM(sessions) sessions, SUM(users) users,
            SUM(engagement_rate * sessions) / NULLIF(SUM(sessions),0) engagement
     FROM ga4_pages WHERE site = ? AND date BETWEEN ? AND ?
     GROUP BY path ORDER BY sessions DESC LIMIT ?`,
    site, start, end, limit
  ).map((r) => ({ ...r, engagement: round((r.engagement ?? 0) * 100, 1) }));
}

export function trafficSources(site, { limit = 6 } = {}) {
  const end = latestDate('ga4_sources', site);
  if (!end) return [];
  const start = daysBefore(end, 27);

  return query(
    `SELECT source, medium, SUM(sessions) sessions
     FROM ga4_sources WHERE site = ? AND date BETWEEN ? AND ?
     GROUP BY source, medium ORDER BY sessions DESC LIMIT ?`,
    site, start, end, limit
  );
}

/**
 * Which words, across the whole network, actually pull clicks.
 *
 * Ten sites on one template is a natural experiment: the app names differ but
 * the search modifiers are shared vocabulary. Aggregating query terms network-wide
 * shows which phrasings earn clicks and which only earn impressions — directly
 * useful when deciding what to put in a new site's titles and headings.
 */
export function networkTerms({ minImpressions = env('INSIGHT_TERM_MIN_IMPRESSIONS', 30), limit = 30 } = {}) {
  const rows = query(
    `SELECT query, SUM(clicks) clicks, SUM(impressions) impressions,
            SUM(position * impressions) / NULLIF(SUM(impressions),0) position
     FROM gsc_queries GROUP BY query`
  );

  const terms = new Map();
  const bump = (term, r) => {
    if (!terms.has(term)) terms.set(term, { term, clicks: 0, impressions: 0, weighted: 0, queries: 0 });
    const t = terms.get(term);
    t.clicks += r.clicks;
    t.impressions += r.impressions;
    t.weighted += (r.position ?? 0) * r.impressions;
    t.queries += 1;
  };

  for (const r of rows) {
    const words = String(r.query)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));

    for (const w of new Set(words)) bump(w, r);
    for (let i = 0; i < words.length - 1; i++) bump(`${words[i]} ${words[i + 1]}`, r);
  }

  return [...terms.values()]
    .filter((t) => t.impressions >= minImpressions)
    .map((t) => ({
      term: t.term,
      clicks: t.clicks,
      impressions: t.impressions,
      ctr: round((t.clicks / t.impressions) * 100, 1),
      position: round(t.weighted / t.impressions, 1),
      queries: t.queries,
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, limit);
}

/**
 * Legal and boilerplate pages every site carries. They are separated from real
 * content because they dominate the unindexed count while being worth nothing
 * in search — nobody looks for your DMCA page. Blending them into one figure
 * makes a healthy site look broken, and hides a genuine content gap behind
 * noise about privacy policies.
 */
const UTILITY_PAGE =
  /\/(about|about-us|contact|contact-us|dmca|privacy-policy|privacy|terms-and-conditions|terms|terms-of-service|disclaimer|download)\/?$/i;

export function isUtilityPage(url) {
  try {
    return UTILITY_PAGE.test(new URL(url).pathname);
  } catch {
    return UTILITY_PAGE.test(String(url));
  }
}

/**
 * Utility pages are not inspected at all, so everything here is content.
 * The filter is kept as a safety net for rows harvested before the exclusion
 * existed, or collected with INSPECT_UTILITY_PAGES=1.
 */
export function indexingSummary(site) {
  const rows = query(
    `SELECT url, indexed, coverage_state, canonical_mismatch, rich_verdict
     FROM url_inspections WHERE site = ?`,
    site
  ).filter((r) => !isUtilityPage(r.url));

  if (rows.length === 0) return null;

  const byState = new Map();
  for (const r of rows.filter((r) => !r.indexed)) {
    byState.set(r.coverage_state, (byState.get(r.coverage_state) ?? 0) + 1);
  }

  return {
    checked: rows.length,
    indexed: rows.filter((r) => r.indexed).length,
    notIndexed: rows.filter((r) => !r.indexed).length,
    canonicalIssues: rows.filter((r) => r.canonical_mismatch).length,
    // Only indexed pages count here. Google returns richResultsResult only for
    // pages it has actually processed, so an unindexed page always looks like it
    // has no structured data — counting those turns this into a duplicate of the
    // not-indexed number rather than a schema check.
    noSchema: rows.filter((r) => r.indexed && r.rich_verdict === null).length,
    schemaChecked: rows.filter((r) => r.indexed).length,
    byState: [...byState.entries()]
      .map(([state, n]) => ({ state, n }))
      .sort((a, b) => b.n - a.n),
  };
}

/**
 * Days since Search Console first had data for this site. A brand-new site
 * with half its pages unindexed is behaving normally; the same figure on a
 * three-month-old site is a problem. Without this the report cannot tell the
 * difference and cries wolf on every launch.
 */
export function siteAgeDays(site) {
  // Falls back to analytics data: a site with zero search impressions so far
  // has no gsc_pages rows at all, and "unknown age" would hide exactly the
  // young-site context that explains its empty search numbers.
  const first =
    query(`SELECT MIN(date) d FROM gsc_pages WHERE site = ?`, site)[0]?.d ??
    query(`SELECT MIN(date) d FROM ga4_pages WHERE site = ?`, site)[0]?.d;

  if (!first) return null;
  return Math.round((Date.now() - Date.parse(`${first}T00:00:00Z`)) / 86400000);
}

export function notIndexedPages(site, { limit = 25 } = {}) {
  return query(
    `SELECT url, coverage_state, indexing_state, page_fetch_state, last_crawl,
            google_canonical, user_canonical, canonical_mismatch
     FROM url_inspections WHERE site = ? AND indexed = 0
     ORDER BY coverage_state, url`,
    site
  )
    .filter((r) => !isUtilityPage(r.url))
    .slice(0, limit);
}

export function canonicalConflicts(site) {
  return query(
    `SELECT url, user_canonical, google_canonical FROM url_inspections
     WHERE site = ? AND canonical_mismatch = 1`,
    site
  );
}

export function siteInsights(site) {
  return {
    strikingDistance: strikingDistance(site),
    ctrGaps: ctrGaps(site),
    zeroClick: zeroClickQueries(site),
    movement: queryMovement(site),
    topPages: topPages(site),
    deadPages: deadPages(site),
    landingPages: topLandingPages(site),
    countries: topCountries(site),
    sources: trafficSources(site),
  };
}

function env(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function round(v, dp) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  const f = 10 ** dp;
  return Math.round(Number(v) * f) / f;
}
