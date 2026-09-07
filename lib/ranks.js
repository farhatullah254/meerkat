import { fetchDimensions } from './gsc.js';
import { countryName } from './countries.js';
import { query, upsertMany } from './history.js';

const TRACK_COUNT = 5;
const WINDOW_DAYS = 14;

/**
 * The five queries actually earning this site clicks over the last 7 days.
 *
 * Chosen by clicks rather than impressions on purpose: impressions reward
 * queries the site appears for but nobody wants, while clicks identify the
 * terms that are genuinely carrying the site and therefore the ones whose
 * movement matters.
 */
export function selectTrackedKeywords(site, n = TRACK_COUNT) {
  const end = query(`SELECT MAX(date) d FROM gsc_queries WHERE site = ?`, site)[0]?.d;
  if (!end) return [];

  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 6);

  const rows = query(
    `SELECT query, SUM(clicks) clicks, SUM(impressions) impressions
     FROM gsc_queries WHERE site = ? AND date BETWEEN ? AND ?
     GROUP BY query
     ORDER BY clicks DESC, impressions DESC
     LIMIT ?`,
    site, start.toISOString().slice(0, 10), end, n
  ).filter((r) => r.clicks > 0 || r.impressions >= 10);

  const today = new Date().toISOString().slice(0, 10);
  upsertMany('tracked_keywords', rows.map((r) => [site, r.query, today, r.clicks]));

  return rows.map((r) => r.query);
}

/**
 * Store daily positions for the tracked set, blended and split by device and
 * country.
 *
 * The split is the point. A blended average across every country is close to
 * meaningless when a site's traffic is spread over the US, Indonesia and
 * Pakistan — "position 9" can be position 4 in one market and 20 in another,
 * and only the split tells you which.
 */
export async function snapshotRanks(site) {
  const tracked = selectTrackedKeywords(site.name);
  if (tracked.length === 0 || !site.gscSite) return { tracked: 0, rows: 0 };

  const want = new Set(tracked);
  let rows = 0;

  // Blended figure comes from data already harvested — no extra API call.
  const blended = query(
    `SELECT date, query, position, clicks, impressions FROM gsc_queries
     WHERE site = ? AND date >= date((SELECT MAX(date) FROM gsc_queries WHERE site = ?), '-${WINDOW_DAYS} days')`,
    site.name, site.name
  ).filter((r) => want.has(r.query));

  rows += upsertMany(
    'rank_tracking',
    blended.map((r) => [site.name, r.date, r.query, 'all', '', r.position, r.clicks, r.impressions])
  );

  for (const [type, dimension] of [['device', 'DEVICE'], ['country', 'COUNTRY']]) {
    try {
      const raw = await fetchDimensions(site.gscSite, ['DATE', 'QUERY', dimension], WINDOW_DAYS);
      const kept = raw.filter((r) => want.has(r.keys[1]));
      rows += upsertMany(
        'rank_tracking',
        kept.map((r) => [
          site.name, r.keys[0], r.keys[1], type, r.keys[2],
          r.position, r.clicks, r.impressions,
        ])
      );
    } catch {
      // A missing segment shouldn't lose the blended data we already stored.
    }
  }

  return { tracked: tracked.length, rows };
}

/** Today's position against the trailing 7-day average, per tracked keyword. */
export function rankReport(site) {
  const end = query(
    `SELECT MAX(date) d FROM rank_tracking WHERE site = ? AND segment_type = 'all'`,
    site
  )[0]?.d;
  if (!end) return [];

  const dayBefore = (n) => {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };

  const tracked = query(`SELECT query FROM tracked_keywords WHERE site = ?`, site).map((r) => r.query);

  return tracked
    .map((q) => {
      // Today: the single most recent day Search Console has data for. That is
      // typically yesterday, since the feed runs a day or two behind — `end` is
      // taken from the data, not the clock, so it is always a real day.
      const current = query(
        `SELECT position, clicks, impressions FROM rank_tracking
         WHERE site = ? AND query = ? AND segment_type = 'all' AND date = ?`,
        site, q, end
      )[0];

      // The last 7 days, as the baseline to compare today against.
      const prior = query(
        `SELECT SUM(position * impressions) / NULLIF(SUM(impressions),0) position,
                SUM(clicks) clicks, SUM(impressions) impressions
         FROM rank_tracking
         WHERE site = ? AND query = ? AND segment_type = 'all' AND date BETWEEN ? AND ?`,
        site, q, dayBefore(6), end
      )[0];

      // When today is blank, say when it was last seen instead of just "lost".
      // On a low-volume keyword a quiet day is normal; a keyword that has been
      // gone a week is not, and the two need to look different.
      const lastSeen = query(
        `SELECT date, position FROM rank_tracking
         WHERE site = ? AND query = ? AND segment_type = 'all' AND impressions > 0
         ORDER BY date DESC LIMIT 1`,
        site, q
      )[0];

      const byCountry = query(
        `SELECT segment, SUM(position * impressions) / NULLIF(SUM(impressions),0) position,
                SUM(impressions) impressions
         FROM rank_tracking
         WHERE site = ? AND query = ? AND segment_type = 'country' AND date >= ?
         GROUP BY segment ORDER BY impressions DESC LIMIT 4`,
        site, q, dayBefore(6)
      );

      const byDevice = query(
        `SELECT segment, SUM(position * impressions) / NULLIF(SUM(impressions),0) position,
                SUM(impressions) impressions
         FROM rank_tracking
         WHERE site = ? AND query = ? AND segment_type = 'device' AND date >= ?
         GROUP BY segment ORDER BY impressions DESC`,
        site, q, dayBefore(6)
      );

      const now = current?.impressions > 0 ? current.position : null;
      const was = prior?.position ?? null;

      const daysSinceSeen = lastSeen
        ? Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${lastSeen.date}T00:00:00Z`)) / 86400000)
        : null;

      return {
        query: q,
        date: end,
        position: r1(now),
        priorPosition: r1(was),
        // Positive means improved: in search, a smaller number is better.
        change: now !== null && was !== null ? r1(was - now) : null,
        clicks: current?.clicks ?? 0,
        impressions: current?.impressions ?? 0,
        lastSeenDate: lastSeen?.date ?? null,
        lastSeenPosition: r1(lastSeen?.position),
        daysSinceSeen,
        lost: now === null && was !== null,
        // Deliberately a 7-day window while the headline is a single day. One
        // country over one day is almost always too few impressions to mean
        // anything. Labelled as 7-day in the UI so the two are not read as
        // disagreeing with each other.
        byCountry: byCountry.map((c) => ({
          ...c,
          position: r1(c.position),
          label: countryName(c.segment),
        })),
        byDevice: byDevice.map((d) => ({ ...d, position: r1(d.position) })),
      };
    })
    .filter((r) => r.position !== null || r.priorPosition !== null)
    .sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
}

/**
 * Tracked keywords that have moved enough to be worth a notification.
 *
 * Losing impressions entirely is treated as the more serious event: a keyword
 * that fell from position 4 to nowhere has usually been dropped from the index
 * or overtaken completely, which is a different problem from sliding a few places.
 */
export function rankAlerts(site, { minDrop = 5, minPriorPosition = 30, staleDays = 3 } = {}) {
  return rankReport(site)
    .filter((r) => r.priorPosition !== null && r.priorPosition <= minPriorPosition)
    .flatMap((r) => {
      if (r.position === null) {
        // A single blank day on a low-volume keyword is normal, so the alert
        // waits until it has been absent for several days before firing.
        if ((r.daysSinceSeen ?? 99) < staleDays) return [];
        return [{
          site,
          rule: 'rank_lost',
          severity: 'critical',
          message:
            `${site.trim()}: "${r.query}" has had no impressions for ${r.daysSinceSeen} days — ` +
            `last seen at position ${r.lastSeenPosition}.`,
        }];
      }
      if (r.change !== null && r.change <= -minDrop) {
        return [{
          site,
          rule: 'rank_drop',
          severity: 'critical',
          message:
            `${site.trim()}: "${r.query}" fell from ${r.priorPosition} to ${r.position} ` +
            `(${r.change} places).`,
        }];
      }
      return [];
    });
}

/**
 * Null and empty string both coerce to 0, which would report "no data for this
 * keyword" as "ranking first" — the most dangerous possible misreading. Guard
 * before touching Number().
 */
function r1(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}
