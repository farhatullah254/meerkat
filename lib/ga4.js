import { googlePost } from './auth.js';

const BASE = 'https://analyticsdata.googleapis.com/v1beta';

const BASELINE_DAYS = 14;
const HISTORY_DAYS = 28;

/** Active users in the last 30 minutes — the number the GA4 Realtime card shows. */
export async function fetchRealtime(propertyId) {
  const res = await googlePost(`${BASE}/properties/${propertyId}:runRealtimeReport`, {
    metrics: [{ name: 'activeUsers' }],
  });
  return num(res.rows?.[0]?.metricValues?.[0]?.value);
}

/**
 * One batched call covering everything the daily tab needs.
 *
 * Three separate reports rather than one, because GA4 user counts are
 * de-duplicated per query: summing activeUsers across hour buckets would
 * count the same visitor once per hour they were around. Sessions are
 * additive, so the hourly report uses those and the user totals come from
 * queries scoped to the exact window being reported.
 */
export async function fetchDaily(propertyId) {
  const res = await googlePost(`${BASE}/properties/${propertyId}:batchRunReports`, {
    requests: [
      {
        dateRanges: [{ startDate: `${HISTORY_DAYS}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'totalUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
        limit: 100,
      },
      {
        dateRanges: [{ startDate: `${BASELINE_DAYS}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'date' }, { name: 'hour' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [
          { dimension: { dimensionName: 'date' } },
          { dimension: { dimensionName: 'hour' } },
        ],
        limit: 1000,
      },
      {
        dateRanges: [{ startDate: '6daysAgo', endDate: 'today' }],
        metrics: [{ name: 'totalUsers' }, { name: 'sessions' }],
      },
    ],
  });

  const [byDay, byHour, weekTotals] = res.reports ?? [];

  const daily = (byDay?.rows ?? []).map((r) => ({
    date: r.dimensionValues[0].value,
    users: num(r.metricValues[0].value),
    sessions: num(r.metricValues[1].value),
    views: num(r.metricValues[2].value),
  }));

  const hourly = (byHour?.rows ?? []).map((r) => ({
    date: r.dimensionValues[0].value,
    hour: Number(r.dimensionValues[1].value),
    sessions: num(r.metricValues[0].value),
  }));

  // Anchor "now" to the newest bucket GA4 actually returned rather than to the
  // local clock, so a property in another timezone still lines up correctly.
  const today = daily.at(-1)?.date ?? null;
  const yesterday = daily.at(-2)?.date ?? null;
  const currentHour = today
    ? Math.max(-1, ...hourly.filter((h) => h.date === today).map((h) => h.hour))
    : -1;

  // Complete days only — today is partial and would understate every comparison.
  const complete = daily.slice(0, -1);
  const lastWeek = complete.slice(-7);
  const priorWeek = complete.slice(-14, -7);

  return {
    usersToday: daily.at(-1)?.users ?? 0,
    usersYesterday: daily.at(-2)?.users ?? 0,
    sessionsLast7: sumBy(lastWeek, 'sessions'),
    sessionsPrior7: priorWeek.length > 0 ? sumBy(priorWeek, 'sessions') : null,
    usersLast7Daily: sumBy(lastWeek, 'users'),
    usersPrior7Daily: priorWeek.length > 0 ? sumBy(priorWeek, 'users') : null,
    users7d: num(weekTotals?.rows?.[0]?.metricValues?.[0]?.value),
    sessions7d: num(weekTotals?.rows?.[0]?.metricValues?.[1]?.value),
    sessions24h: rolling24h(hourly),
    viewsToday: daily.at(-1)?.views ?? 0,
    today,
    yesterday,
    currentHour,
    pace: pace(hourly, today, currentHour),
    daily,
    hourly: hourly.slice(-48),
  };
}

/**
 * Dimensional pull for the harvest job: which pages earn the traffic, where it
 * comes from geographically, and which channels deliver it.
 */
export async function fetchDimensional(propertyId, days = HISTORY_DAYS) {
  const range = [{ startDate: `${days}daysAgo`, endDate: 'today' }];

  const res = await googlePost(`${BASE}/properties/${propertyId}:batchRunReports`, {
    requests: [
      {
        dateRanges: range,
        dimensions: [{ name: 'date' }, { name: 'landingPagePlusQueryString' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'screenPageViews' },
          { name: 'engagementRate' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 5000,
      },
      {
        dateRanges: range,
        dimensions: [{ name: 'date' }, { name: 'country' }],
        metrics: [{ name: 'totalUsers' }, { name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 5000,
      },
      {
        dateRanges: range,
        dimensions: [{ name: 'date' }, { name: 'sessionSource' }, { name: 'sessionMedium' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 5000,
      },
    ],
  });

  const [pages, countries, sources] = res.reports ?? [];

  return {
    pages: (pages?.rows ?? []).map((r) => ({
      date: r.dimensionValues[0].value,
      path: r.dimensionValues[1].value,
      sessions: num(r.metricValues[0].value),
      users: num(r.metricValues[1].value),
      views: num(r.metricValues[2].value),
      engagementRate: num(r.metricValues[3].value),
    })),
    countries: (countries?.rows ?? []).map((r) => ({
      date: r.dimensionValues[0].value,
      country: r.dimensionValues[1].value,
      users: num(r.metricValues[0].value),
      sessions: num(r.metricValues[1].value),
    })),
    sources: (sources?.rows ?? []).map((r) => ({
      date: r.dimensionValues[0].value,
      source: r.dimensionValues[1].value,
      medium: r.dimensionValues[2].value,
      sessions: num(r.metricValues[0].value),
    })),
  };
}

/** Sessions across the most recent 24 hourly buckets — additive, so safe to sum. */
function rolling24h(hourly) {
  return hourly.slice(-24).reduce((sum, h) => sum + h.sessions, 0);
}

/**
 * Compare today's sessions-so-far against the same slice of the previous
 * 14 days. Comparing a part-day against full-day averages would flag every
 * site as "down" every morning, which is why this cuts each historical day
 * at the same hour.
 */
function pace(hourly, today, currentHour) {
  if (!today || currentHour < 0) {
    return { actual: 0, expected: null, deviationPct: null, days: 0 };
  }

  const upToHour = (date) =>
    hourly
      .filter((h) => h.date === date && h.hour <= currentHour)
      .reduce((sum, h) => sum + h.sessions, 0);

  const priorDates = [...new Set(hourly.map((h) => h.date))].filter((d) => d !== today);
  const actual = upToHour(today);

  if (priorDates.length === 0) {
    return { actual, expected: null, deviationPct: null, days: 0 };
  }

  const totals = priorDates.map(upToHour);
  const expected = totals.reduce((a, b) => a + b, 0) / totals.length;
  const deviationPct = expected > 0 ? ((actual - expected) / expected) * 100 : null;

  // How much this site normally bounces around, in sessions. A site that swings
  // 10-70 every day and a site that sits at 40±2 can both be "50% down" while
  // only one of them is actually news, so alerting works off this rather than
  // off the percentage.
  const variance =
    totals.length > 1
      ? totals.reduce((t, v) => t + (v - expected) ** 2, 0) / (totals.length - 1)
      : 0;
  const stdev = Math.sqrt(variance);
  const z = stdev > 0 ? (actual - expected) / stdev : null;

  return {
    actual,
    expected: Math.round(expected * 10) / 10,
    deviationPct: deviationPct === null ? null : Math.round(deviationPct),
    stdev: Math.round(stdev * 10) / 10,
    z: z === null ? null : Math.round(z * 100) / 100,
    days: priorDates.length,
  };
}

function sumBy(rows, key) {
  return rows.reduce((t, r) => t + (r[key] ?? 0), 0);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
