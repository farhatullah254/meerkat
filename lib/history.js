import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

mkdirSync(DATA_DIR, { recursive: true });

// AKE_DB_PATH lets tests and experiments point at a throwaway file. Without it,
// anything that calls the alert engine writes into the real history — which is
// how synthetic test alerts end up in the dashboard.
const DB_PATH = process.env.AKE_DB_PATH || path.join(DATA_DIR, 'ake-analytics.db');

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    site            TEXT NOT NULL,
    ts              INTEGER NOT NULL,
    active_now      INTEGER,
    users_today     INTEGER,
    users_yesterday INTEGER,
    sessions_24h    INTEGER,
    clicks_24h      INTEGER,
    clicks_7d       INTEGER,
    impressions_7d  INTEGER,
    position_7d     REAL,
    http_ok         INTEGER,
    http_status     INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_site_ts ON snapshots (site, ts);

  CREATE TABLE IF NOT EXISTS alerts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    site     TEXT NOT NULL,
    rule     TEXT NOT NULL,
    severity TEXT NOT NULL,
    message  TEXT NOT NULL,
    fired_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_alerts_fired ON alerts (fired_at);

  CREATE TABLE IF NOT EXISTS alert_state (
    key        TEXT PRIMARY KEY,
    last_fired INTEGER NOT NULL
  );

  -- Dimensional history. Keyed on (site, date, thing) so a re-harvest of the
  -- same day overwrites rather than duplicating; Search Console revises the
  -- last few days upward, and we want the revision, not both versions.

  CREATE TABLE IF NOT EXISTS gsc_queries (
    site TEXT NOT NULL, date TEXT NOT NULL, query TEXT NOT NULL,
    clicks INTEGER, impressions INTEGER, ctr REAL, position REAL,
    PRIMARY KEY (site, date, query)
  );
  CREATE INDEX IF NOT EXISTS idx_gq_site_date ON gsc_queries (site, date);
  CREATE INDEX IF NOT EXISTS idx_gq_query ON gsc_queries (query);

  CREATE TABLE IF NOT EXISTS gsc_pages (
    site TEXT NOT NULL, date TEXT NOT NULL, page TEXT NOT NULL,
    clicks INTEGER, impressions INTEGER, ctr REAL, position REAL,
    PRIMARY KEY (site, date, page)
  );
  CREATE INDEX IF NOT EXISTS idx_gp_site_date ON gsc_pages (site, date);

  CREATE TABLE IF NOT EXISTS ga4_pages (
    site TEXT NOT NULL, date TEXT NOT NULL, path TEXT NOT NULL,
    sessions INTEGER, users INTEGER, views INTEGER, engagement_rate REAL,
    PRIMARY KEY (site, date, path)
  );
  CREATE INDEX IF NOT EXISTS idx_ap_site_date ON ga4_pages (site, date);

  CREATE TABLE IF NOT EXISTS ga4_countries (
    site TEXT NOT NULL, date TEXT NOT NULL, country TEXT NOT NULL,
    users INTEGER, sessions INTEGER,
    PRIMARY KEY (site, date, country)
  );

  CREATE TABLE IF NOT EXISTS ga4_sources (
    site TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL, medium TEXT NOT NULL,
    sessions INTEGER,
    PRIMARY KEY (site, date, source, medium)
  );

  -- One row per URL, overwritten each inspection. url_inspection_history keeps
  -- the trail so "page fell out of the index on the 9th" stays answerable.
  CREATE TABLE IF NOT EXISTS url_inspections (
    site TEXT NOT NULL, url TEXT NOT NULL,
    checked_at INTEGER NOT NULL, indexed INTEGER,
    verdict TEXT, coverage_state TEXT, robots_state TEXT, indexing_state TEXT,
    page_fetch_state TEXT, last_crawl TEXT,
    google_canonical TEXT, user_canonical TEXT, canonical_mismatch INTEGER,
    sitemaps TEXT, rich_verdict TEXT, rich_issues INTEGER, inspection_link TEXT,
    PRIMARY KEY (site, url)
  );
  CREATE INDEX IF NOT EXISTS idx_ui_site ON url_inspections (site, indexed);

  CREATE TABLE IF NOT EXISTS url_inspection_history (
    site TEXT NOT NULL, url TEXT NOT NULL, date TEXT NOT NULL,
    indexed INTEGER, coverage_state TEXT,
    PRIMARY KEY (site, url, date)
  );

  -- Daily rank snapshots. segment_type is 'all', 'device' or 'country' so one
  -- table serves the blended figure and the segmented ones.
  CREATE TABLE IF NOT EXISTS rank_tracking (
    site TEXT NOT NULL, date TEXT NOT NULL, query TEXT NOT NULL,
    segment_type TEXT NOT NULL, segment TEXT NOT NULL,
    position REAL, clicks INTEGER, impressions INTEGER,
    PRIMARY KEY (site, date, query, segment_type, segment)
  );
  CREATE INDEX IF NOT EXISTS idx_rt_site_query ON rank_tracking (site, query, date);

  CREATE TABLE IF NOT EXISTS tracked_keywords (
    site TEXT NOT NULL, query TEXT NOT NULL,
    added_on TEXT NOT NULL, clicks_at_selection INTEGER,
    PRIMARY KEY (site, query)
  );

  CREATE TABLE IF NOT EXISTS harvest_log (
    site TEXT NOT NULL, kind TEXT NOT NULL,
    last_run INTEGER NOT NULL, rows INTEGER, error TEXT,
    PRIMARY KEY (site, kind)
  );
`);

const UPSERTS = {
  gsc_queries: db.prepare(
    `INSERT OR REPLACE INTO gsc_queries (site,date,query,clicks,impressions,ctr,position)
     VALUES (?,?,?,?,?,?,?)`
  ),
  gsc_pages: db.prepare(
    `INSERT OR REPLACE INTO gsc_pages (site,date,page,clicks,impressions,ctr,position)
     VALUES (?,?,?,?,?,?,?)`
  ),
  ga4_pages: db.prepare(
    `INSERT OR REPLACE INTO ga4_pages (site,date,path,sessions,users,views,engagement_rate)
     VALUES (?,?,?,?,?,?,?)`
  ),
  ga4_countries: db.prepare(
    `INSERT OR REPLACE INTO ga4_countries (site,date,country,users,sessions) VALUES (?,?,?,?,?)`
  ),
  ga4_sources: db.prepare(
    `INSERT OR REPLACE INTO ga4_sources (site,date,source,medium,sessions) VALUES (?,?,?,?,?)`
  ),
  url_inspections: db.prepare(
    `INSERT OR REPLACE INTO url_inspections
       (site,url,checked_at,indexed,verdict,coverage_state,robots_state,indexing_state,
        page_fetch_state,last_crawl,google_canonical,user_canonical,canonical_mismatch,
        sitemaps,rich_verdict,rich_issues,inspection_link)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ),
  url_inspection_history: db.prepare(
    `INSERT OR REPLACE INTO url_inspection_history (site,url,date,indexed,coverage_state)
     VALUES (?,?,?,?,?)`
  ),
  rank_tracking: db.prepare(
    `INSERT OR REPLACE INTO rank_tracking
       (site,date,query,segment_type,segment,position,clicks,impressions)
     VALUES (?,?,?,?,?,?,?,?)`
  ),
  tracked_keywords: db.prepare(
    `INSERT OR REPLACE INTO tracked_keywords (site,query,added_on,clicks_at_selection)
     VALUES (?,?,?,?)`
  ),
};

const logHarvest = db.prepare(
  `INSERT OR REPLACE INTO harvest_log (site,kind,last_run,rows,error) VALUES (?,?,?,?,?)`
);

/** Batched insert inside one transaction — thousands of rows otherwise crawl. */
export function upsertMany(table, rows) {
  const stmt = UPSERTS[table];
  if (!stmt) throw new Error(`unknown table ${table}`);
  if (rows.length === 0) return 0;

  db.exec('BEGIN');
  try {
    for (const r of rows) stmt.run(...r);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

export function recordHarvest(site, kind, rows, error = null) {
  logHarvest.run(site, kind, Date.now(), rows, error);
}

export function getHarvestLog() {
  return db.prepare(`SELECT * FROM harvest_log ORDER BY site, kind`).all();
}

export function query(sql, ...params) {
  return db.prepare(sql).all(...params);
}

const insertSnapshot = db.prepare(`
  INSERT INTO snapshots
    (site, ts, active_now, users_today, users_yesterday, sessions_24h,
     clicks_24h, clicks_7d, impressions_7d, position_7d, http_ok, http_status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAlert = db.prepare(
  `INSERT INTO alerts (site, rule, severity, message, fired_at) VALUES (?, ?, ?, ?, ?)`
);

const readAlertState = db.prepare(`SELECT last_fired FROM alert_state WHERE key = ?`);

const writeAlertState = db.prepare(`
  INSERT INTO alert_state (key, last_fired) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET last_fired = excluded.last_fired
`);

const recentAlerts = db.prepare(
  `SELECT site, rule, severity, message, fired_at FROM alerts ORDER BY fired_at DESC LIMIT ?`
);

const siteSeries = db.prepare(`
  SELECT ts, active_now, users_today, sessions_24h, clicks_24h, http_ok
  FROM snapshots WHERE site = ? AND ts >= ? ORDER BY ts ASC
`);

const pruneSnapshots = db.prepare(`DELETE FROM snapshots WHERE ts < ?`);
const pruneAlerts = db.prepare(`DELETE FROM alerts WHERE fired_at < ?`);

export function recordSnapshot(site, s) {
  insertSnapshot.run(
    site,
    Date.now(),
    intOrNull(s.activeNow),
    intOrNull(s.ga4?.usersToday),
    intOrNull(s.ga4?.usersYesterday),
    intOrNull(s.ga4?.sessions24h),
    intOrNull(s.gsc?.clicks24h),
    intOrNull(s.gsc?.clicks7d),
    intOrNull(s.gsc?.impressions7d),
    numOrNull(s.gsc?.position7d),
    s.health?.ok === null || s.health?.ok === undefined ? null : s.health.ok ? 1 : 0,
    intOrNull(s.health?.status)
  );
}

export function recordAlert({ site, rule, severity, message }) {
  insertAlert.run(site, rule, severity, message, Date.now());
}

export function lastFired(key) {
  return readAlertState.get(key)?.last_fired ?? 0;
}

export function markFired(key) {
  writeAlertState.run(key, Date.now());
}

export function getRecentAlerts(limit = 50) {
  return recentAlerts.all(limit);
}

export function getSiteSeries(site, days = 30) {
  return siteSeries.all(site, Date.now() - days * 86400000);
}

/** Keep the file small enough that it never needs thinking about. */
export function prune(retentionDays = 120) {
  const cutoff = Date.now() - retentionDays * 86400000;
  pruneSnapshots.run(cutoff);
  pruneAlerts.run(cutoff);
}

function intOrNull(v) {
  return Number.isFinite(v) ? Math.round(v) : null;
}

function numOrNull(v) {
  return Number.isFinite(v) ? v : null;
}
