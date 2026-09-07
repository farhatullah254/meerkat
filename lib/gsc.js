import { googlePost } from './auth.js';

const BASE = 'https://searchconsole.googleapis.com/webmasters/v3/sites';

const HISTORY_DAYS = 27;

function endpoint(siteUrl) {
  return `${BASE}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
}

/** GSC reports on Pacific time regardless of where you or the site are. */
function pacificDate(daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export async function fetchSearchConsole(siteUrl) {
  const [hourly, daily] = await Promise.all([last24Hours(siteUrl), dailySeries(siteUrl)]);

  const last7 = daily.slice(-7);
  const clicks7d = sum(last7, 'clicks');
  const impressions7d = sum(last7, 'impressions');

  // Days 8-14 back. Deliberately excludes the last week so a decline already
  // in progress can't drag its own reference point down with it — the failure
  // mode that let a site bleed from 40 clicks/day to zero without a word.
  const prior7 = daily.slice(-14, -7);
  const baselineDailyClicks = prior7.length > 0 ? sum(prior7, 'clicks') / prior7.length : null;

  return {
    clicks24h: hourly.clicks,
    impressions24h: hourly.impressions,
    hourly: hourly.buckets,
    hourlyAvailable: hourly.available,
    hourlyError: hourly.error,
    freshness: hourly.freshness ?? null,
    clicks7d,
    impressions7d,
    ctr7d: impressions7d > 0 ? clicks7d / impressions7d : 0,
    position7d: weightedPosition(last7),
    avgDailyClicks7d: last7.length > 0 ? clicks7d / last7.length : 0,
    stdevDailyClicks7d: stdev(last7.map((d) => d.clicks)),
    baselineDailyClicks,
    clicksPrev7d: prior7.length > 0 ? sum(prior7, 'clicks') : null,
    impressionsPrev7d: prior7.length > 0 ? sum(prior7, 'impressions') : null,
    daily,
  };
}

function stdev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((t, v) => t + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * The HOUR dimension with dataState HOURLY_ALL is the only way to get
 * same-day Search Console numbers. It is newer than the rest of the API and
 * not every property serves it, so a failure here degrades to "unavailable"
 * instead of taking the whole site's row down.
 */
async function last24Hours(siteUrl) {
  const empty = {
    clicks: null, impressions: null, buckets: [],
    available: false, error: null, freshness: null,
  };

  let res;
  try {
    res = await googlePost(endpoint(siteUrl), {
      startDate: pacificDate(2),
      endDate: pacificDate(0),
      dimensions: ['HOUR'],
      dataState: 'HOURLY_ALL',
      rowLimit: 200,
    });
  } catch (err) {
    return { ...empty, error: err.message };
  }

  const all = (res.rows ?? [])
    .map((r) => ({
      ts: Date.parse(r.keys[0]),
      label: r.keys[0],
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
    }))
    .filter((b) => Number.isFinite(b.ts))
    .sort((a, b) => a.ts - b.ts);

  if (all.length === 0) {
    return { clicks: 0, impressions: 0, buckets: [], available: true, error: null, freshness: null };
  }

  // Anchor the window to the newest bucket Google actually has, not to the wall
  // clock. Hourly data runs several hours behind real time, so counting back
  // from "now" silently drops that many hours off the far end and reports a
  // number lower than Search Console's own last-24-hours view.
  const newest = all.at(-1).ts;
  const cutoff = newest - 23 * 3600 * 1000;
  const buckets = all.filter((b) => b.ts >= cutoff);

  return {
    clicks: sum(buckets, 'clicks'),
    impressions: sum(buckets, 'impressions'),
    buckets,
    available: true,
    error: null,
    // Surfaced so the dashboard can say how stale the figure is rather than
    // implying it is live.
    freshness: { newest: all.at(-1).label, lagHours: Math.round((Date.now() - newest) / 3600000) },
  };
}

async function dailySeries(siteUrl) {
  const res = await googlePost(endpoint(siteUrl), {
    startDate: pacificDate(HISTORY_DAYS),
    endDate: pacificDate(0),
    dimensions: ['DATE'],
    dataState: 'ALL',
    rowLimit: 500,
  });

  return (res.rows ?? [])
    .map((r) => ({
      date: r.keys[0],
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Paged pull of any dimension combination, for the harvest job.
 * Search Console caps a single response at 25k rows, so anything broader than
 * one site's queries needs to walk startRow.
 */
export async function fetchDimensions(siteUrl, dimensions, days, maxRows = 25000) {
  const pageSize = 5000;
  const rows = [];

  for (let startRow = 0; startRow < maxRows; startRow += pageSize) {
    const res = await googlePost(endpoint(siteUrl), {
      startDate: pacificDate(days),
      endDate: pacificDate(0),
      dimensions,
      dataState: 'ALL',
      rowLimit: pageSize,
      startRow,
    });

    const batch = res.rows ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }

  return rows.map((r) => ({
    keys: r.keys,
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}

export function fetchQueryRows(siteUrl, days = 28) {
  return fetchDimensions(siteUrl, ['DATE', 'QUERY'], days);
}

export function fetchPageRows(siteUrl, days = 28) {
  return fetchDimensions(siteUrl, ['DATE', 'PAGE'], days);
}

function sum(rows, key) {
  return rows.reduce((total, r) => total + (r[key] ?? 0), 0);
}

function weightedPosition(rows) {
  const impressions = sum(rows, 'impressions');
  if (impressions === 0) return 0;
  const weighted = rows.reduce((t, r) => t + r.position * r.impressions, 0);
  return weighted / impressions;
}
