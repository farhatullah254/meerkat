import 'dotenv/config';
import express from 'express';
import { PUBLIC_DIR } from './lib/paths.js';
import { loadSites } from './lib/config.js';
import { getServiceAccountEmail } from './lib/auth.js';
import { fetchRealtime, fetchDaily } from './lib/ga4.js';
import { fetchSearchConsole } from './lib/gsc.js';
import { checkSite } from './lib/health.js';
import { evaluate, notifyMacOS } from './lib/alerts.js';
import { harvestAll } from './lib/harvest.js';
import { buildDigest } from './lib/digest.js';
import { reconcile } from './lib/reconcile.js';
import { indexingSummary, notIndexedPages, siteAgeDays } from './lib/insights.js';
import { rankReport, rankAlerts } from './lib/ranks.js';
import {
  recordSnapshot,
  getRecentAlerts,
  getSiteSeries,
  getHarvestLog,
  lastFired,
  markFired,
  recordAlert,
  prune,
} from './lib/history.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './lib/paths.js';

const REALTIME_MS = 60_000;
const DAILY_MS = 15 * 60_000;
const HEALTH_MS = 5 * 60_000;
const HARVEST_CHECK_MS = 60 * 60_000;
const HARVEST_INTERVAL_MS = 20 * 3600_000;

let sites = [];
let startupError = null;

try {
  sites = loadSites();
  getServiceAccountEmail();
} catch (err) {
  startupError = err.message;
}

/** Latest known value per site. Written by the pollers, read by the API. */
const state = new Map();

function slot(name) {
  if (!state.has(name)) {
    state.set(name, {
      name,
      activeNow: null,
      ga4: null,
      gsc: null,
      health: null,
      errors: {},
      updated: {},
    });
  }
  return state.get(name);
}

function settle(name, field, value) {
  const s = slot(name);
  s[field] = value;
  s.errors[field] = null;
  s.updated[field] = Date.now();
}

function fail(name, field, err) {
  const s = slot(name);
  s.errors[field] = err.message;
  s.updated[field] = Date.now();
  console.error(`[${name}] ${field}: ${err.message}`);
}

async function pollRealtime() {
  await Promise.all(
    sites
      .filter((s) => s.ga4PropertyId)
      .map(async (site) => {
        try {
          settle(site.name, 'activeNow', await fetchRealtime(site.ga4PropertyId));
        } catch (err) {
          fail(site.name, 'activeNow', err);
        }
      })
  );
}

async function pollDaily() {
  await Promise.all(
    sites.map(async (site) => {
      if (site.ga4PropertyId) {
        try {
          settle(site.name, 'ga4', await fetchDaily(site.ga4PropertyId));
        } catch (err) {
          fail(site.name, 'ga4', err);
        }
      }
      if (site.gscSite) {
        try {
          settle(site.name, 'gsc', await fetchSearchConsole(site.gscSite));
        } catch (err) {
          fail(site.name, 'gsc', err);
        }
      }
    })
  );

  runAlerts();
  for (const site of sites) recordSnapshot(site.name, slot(site.name));
  prune();
}

async function pollHealth() {
  await Promise.all(
    sites.map(async (site) => {
      settle(site.name, 'health', await checkSite(site.url));
    })
  );
  runAlerts();
}

let harvesting = false;

/**
 * Harvest and digest once a day. Checked hourly rather than scheduled at a
 * fixed time so it still happens on a laptop that spends nights asleep — the
 * timestamp in harvest_log is what decides, not the clock.
 */
async function maybeHarvest() {
  if (harvesting) return;

  const last = Math.max(0, ...getHarvestLog().map((r) => r.last_run ?? 0));
  if (Date.now() - last < HARVEST_INTERVAL_MS) return;

  harvesting = true;
  try {
    await reconcileNewSites();
    console.log('[harvest] starting daily pull');
    const rows = await harvestAll(sites, 28);
    console.log(`[harvest] ${rows} rows`);

    // Rank movement is only known once the harvest has run, so these are
    // evaluated here rather than on the live polling cycle.
    const moves = sites.flatMap((s) => rankAlerts(s.name));
    const fresh = moves.filter((m) => {
      const key = `${m.site}:${m.rule}:${m.message.slice(0, 60)}`;
      if (Date.now() - lastFired(key) < 20 * 3600_000) return false;
      markFired(key);
      recordAlert(m);
      return true;
    });
    if (fresh.length > 0) notifyMacOS(fresh);

    writeDigest();
  } catch (err) {
    console.error('[harvest]', err.message);
  } finally {
    harvesting = false;
  }
}

/**
 * Pick up sites granted since startup, without a restart.
 *
 * Reloading through loadSites() rather than trusting reconcile's return value
 * means the in-memory list always matches what is actually on disk — including
 * any hand-edited names or thresholds.
 */
async function reconcileNewSites() {
  try {
    const result = await reconcile({ write: true });
    if (!result.changed) return;

    sites = loadSites();

    for (const line of result.enriched) console.log(`[sync] ${line}`);
    for (const s of result.added) console.log(`[sync] added ${s.name.trim()}`);

    if (result.added.length > 0) {
      notifyMacOS([
        {
          site: 'Meerkat',
          severity: 'info',
          message:
            `${result.added.length} new site(s) added: ` +
            result.added.map((s) => s.name.trim()).join(', '),
        },
      ]);
    }
  } catch (err) {
    console.error('[sync]', err.message);
  }
}

function writeDigest() {
  try {
    const now = new Date();
    const markdown = buildDigest(sites, now.toISOString().replace('T', ' ').slice(0, 16));
    const dir = path.join(DATA_DIR, 'digests');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${now.toISOString().slice(0, 10)}.md`), `${markdown}\n`);
    writeFileSync(path.join(dir, 'latest.md'), `${markdown}\n`);
    console.log('[digest] data/digests/latest.md updated');
  } catch (err) {
    console.error('[digest]', err.message);
  }
}

function runAlerts() {
  const fired = sites.flatMap((site) => evaluate(site, slot(site.name)));
  if (fired.length > 0) notifyMacOS(fired);
}

function totals() {
  const values = sites.map((s) => slot(s.name));
  const add = (fn) =>
    values.reduce((t, v) => {
      const n = fn(v);
      return t + (Number.isFinite(n) ? n : 0);
    }, 0);

  return {
    activeNow: add((v) => v.activeNow),
    usersToday: add((v) => v.ga4?.usersToday),
    usersYesterday: add((v) => v.ga4?.usersYesterday),
    sessions24h: add((v) => v.ga4?.sessions24h),
    clicks24h: add((v) => v.gsc?.clicks24h),
    clicks7d: add((v) => v.gsc?.clicks7d),
    impressions7d: add((v) => v.gsc?.impressions7d),
    sitesDown: values.filter((v) => v.health?.ok === false).length,
  };
}

const app = express();
app.use(express.static(PUBLIC_DIR));

app.get('/api/state', (_req, res) => {
  if (startupError) return res.status(503).json({ startupError });
  res.json({
    sites: sites.map((site) => ({ ...slot(site.name), url: site.url })),
    totals: totals(),
    alerts: getRecentAlerts(25),
    serverTime: Date.now(),
  });
});

app.get('/api/seo', (_req, res) => {
  if (startupError) return res.status(503).json({ startupError });
  res.json({
    sites: sites.map((site) => ({
      name: site.name,
      url: site.url,
      indexing: indexingSummary(site.name),
      notIndexed: notIndexedPages(site.name),
      ageDays: siteAgeDays(site.name),
      ranks: rankReport(site.name),
    })),
  });
});

app.get('/api/history/:site', (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 120);
  res.json({ site: req.params.site, series: getSiteSeries(req.params.site, days) });
});

app.post('/api/refresh', async (_req, res) => {
  if (startupError) return res.status(503).json({ startupError });
  await Promise.all([pollRealtime(), pollDaily(), pollHealth()]);
  res.json({ ok: true });
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, '127.0.0.1', () => {
  console.log(`\n  Meerkat → http://localhost:${port}\n`);

  if (startupError) {
    console.error(`  Not polling yet: ${startupError}\n`);
    return;
  }

  console.log(`  ${sites.length} sites · service account ${getServiceAccountEmail()}\n`);

  const safe = (fn, label) => () =>
    fn().catch((err) => console.error(`[poll:${label}]`, err.message));

  safe(pollRealtime, 'realtime')();
  safe(pollDaily, 'daily')();
  safe(pollHealth, 'health')();
  safe(maybeHarvest, 'harvest')();

  setInterval(safe(pollRealtime, 'realtime'), REALTIME_MS);
  setInterval(safe(pollDaily, 'daily'), DAILY_MS);
  setInterval(safe(pollHealth, 'health'), HEALTH_MS);
  setInterval(safe(maybeHarvest, 'harvest'), HARVEST_CHECK_MS);
});
