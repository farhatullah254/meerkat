import { execFile } from 'node:child_process';
import { lastFired, markFired, recordAlert } from './history.js';

const consecutiveFailures = new Map();

function env(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function cooldownMs() {
  return env('ALERT_COOLDOWN_HOURS', 6) * 3600 * 1000;
}

/**
 * Evaluate every rule against one site's freshly-pulled state.
 * Returns the alerts that actually fired (post-cooldown), so the caller can
 * both notify and show them in the dashboard banner.
 */
export function evaluate(site, state) {
  const t = site.thresholds ?? {};
  const fired = [];

  const push = (rule, severity, message) => {
    const key = `${site.name}:${rule}`;
    if (Date.now() - lastFired(key) < cooldownMs()) return;
    markFired(key);
    recordAlert({ site: site.name, rule, severity, message });
    fired.push({ site: site.name, rule, severity, message, fired_at: Date.now() });
  };

  trafficDeviation(site, state, t, push);
  trafficSustainedDrop(site, state, t, push);
  gscCollapse(site, state, t, push);
  gscSustainedDrop(site, state, t, push);
  siteUnreachable(site, state, push);

  return fired;
}

/**
 * The slow-bleed detector, and the reason it exists:
 *
 * The z-score rules above compare a site against its own recent scatter. Once a
 * decline has been running for several days, those days are *in* the reference
 * window — the mean falls, the deviation widens, and the collapse starts looking
 * normal. A site can go from 40 clicks a day to zero and never trip a threshold.
 *
 * These two rules compare the last complete week against the week before it, so
 * the reference is never contaminated by the damage being measured.
 */
function trafficSustainedDrop(site, state, t, push) {
  const g = state.ga4;
  if (!g || g.sessionsPrior7 === null || g.sessionsPrior7 === undefined) return;

  const prior = g.sessionsPrior7;
  const current = g.sessionsLast7 ?? 0;
  const minPrior = t.sustainedMinPrior ?? env('SUSTAINED_MIN_PRIOR_SESSIONS', 20);
  if (prior < minPrior) return;

  const dropPct = ((prior - current) / prior) * 100;
  const limit = t.sustainedDropPct ?? env('SUSTAINED_DROP_PCT', 60);
  if (dropPct < limit) return;

  push(
    'traffic_sustained_drop',
    'critical',
    `${site.name}: sessions down ${Math.round(dropPct)}% week over week — ` +
      `${current} in the last 7 days vs ${prior} the week before.`
  );
}

function gscSustainedDrop(site, state, t, push) {
  const c = state.gsc;
  if (!c || c.clicksPrev7d === null || c.clicksPrev7d === undefined) return;

  const prior = c.clicksPrev7d;
  const current = c.clicks7d ?? 0;
  const minPrior = t.sustainedMinPriorClicks ?? env('SUSTAINED_MIN_PRIOR_CLICKS', 15);
  if (prior < minPrior) return;

  const dropPct = ((prior - current) / prior) * 100;
  const limit = t.sustainedDropPct ?? env('SUSTAINED_DROP_PCT', 60);
  if (dropPct < limit) return;

  // Impressions falling with clicks means lost rankings or indexing, not a
  // title problem. Worth saying outright — it changes what you go and fix.
  const impNow = c.impressions7d ?? 0;
  const impPrior = c.impressionsPrev7d ?? 0;
  const cause =
    impPrior > 0 && (impPrior - impNow) / impPrior > 0.4
      ? ' Impressions fell too — check rankings and indexing, not titles.'
      : ' Impressions held up — likely a CTR or SERP-feature problem.';

  push(
    'gsc_sustained_drop',
    'critical',
    `${site.name}: search clicks down ${Math.round(dropPct)}% week over week — ` +
      `${current} vs ${prior}.${cause}`
  );
}

/**
 * Fires on moves that are unusual *for this site*, not on a fixed percentage.
 *
 * Two independent gates, both of which must trip:
 *   1. The move is large relative to the site's own day-to-day scatter (z-score).
 *   2. The move is large in absolute sessions.
 *
 * The z-score handles the volatile sites — one that routinely swings 10-70 needs
 * a genuinely extreme day before it says anything. The absolute floor handles the
 * quiet ones, where a 1→4 change is a huge percentage, a huge z-score, and still
 * not worth a notification.
 *
 * A site with no scatter at all (stdev 0) has no z-score, so it falls back to the
 * percentage rule with the same absolute floor applied.
 */
function trafficDeviation(site, state, t, push) {
  const pace = state.ga4?.pace;
  if (!pace || pace.expected === null || pace.deviationPct === null) return;

  // Needs enough days to say anything about what "normal" looks like.
  const minDays = t.trafficMinDays ?? env('TRAFFIC_MIN_DAYS', 5);
  if (pace.days < minDays) return;

  const minAbs = t.trafficMinAbsDelta ?? env('TRAFFIC_MIN_ABS_DELTA', 8);
  const delta = pace.actual - pace.expected;
  if (Math.abs(delta) < minAbs) return;

  const zLimit = t.trafficZScore ?? env('TRAFFIC_Z_SCORE', 2.5);
  const pctLimit = t.trafficDeviationPct ?? env('TRAFFIC_DEVIATION_PCT', 50);

  let unusual;
  let basis;
  if (pace.z !== null && pace.stdev > 0) {
    unusual = Math.abs(pace.z) >= zLimit;
    basis = `${Math.abs(pace.z).toFixed(1)}σ from its usual ${pace.expected}±${pace.stdev}`;
  } else {
    unusual = Math.abs(pace.deviationPct) >= pctLimit;
    basis = `${Math.abs(pace.deviationPct)}% off a normally flat ${pace.expected}`;
  }
  if (!unusual) return;

  const direction = delta < 0 ? 'down' : 'up';
  push(
    `traffic_${direction}`,
    delta < 0 ? 'critical' : 'info',
    `${site.name}: sessions ${direction} — ${pace.actual} so far vs ~${pace.expected} by ` +
      `this hour, ${basis} over ${pace.days} days.`
  );
}

/** Same two-gate approach as the traffic rule, against the 7-day click pattern. */
function gscCollapse(site, state, t, push) {
  const gsc = state.gsc;
  if (!gsc || gsc.clicks24h === null || gsc.clicks24h === undefined) return;

  const avg = gsc.avgDailyClicks7d;
  const sd = gsc.stdevDailyClicks7d ?? 0;
  const delta = gsc.clicks24h - avg;
  if (delta >= 0) return;

  const minAbs = t.gscMinAbsDelta ?? env('GSC_MIN_ABS_DELTA', 5);
  if (Math.abs(delta) < minAbs) return;

  const zLimit = t.gscZScore ?? env('GSC_Z_SCORE', 2);
  const pctLimit = t.gscDropPct ?? env('GSC_DROP_PCT', 50);

  let unusual;
  let basis;
  if (sd > 0) {
    unusual = Math.abs(delta / sd) >= zLimit;
    basis = `${Math.abs(delta / sd).toFixed(1)}σ below its usual ${avg.toFixed(1)}±${sd.toFixed(1)}`;
  } else {
    unusual = (gsc.clicks24h / avg) * 100 < pctLimit;
    basis = `well below a normally flat ${avg.toFixed(1)}/day`;
  }
  if (!unusual) return;

  push(
    'gsc_clicks_drop',
    'critical',
    `${site.name}: ${gsc.clicks24h} search clicks in 24h — ${basis}.`
  );
}

function siteUnreachable(site, state, push) {
  const health = state.health;
  if (!health || health.ok === null) return;

  if (health.ok) {
    consecutiveFailures.delete(site.name);
    return;
  }

  // Two strikes: a single blip during a deploy or a flaky DNS lookup
  // shouldn't put a notification on screen.
  const misses = (consecutiveFailures.get(site.name) ?? 0) + 1;
  consecutiveFailures.set(site.name, misses);
  if (misses < 2) return;

  push('site_down', 'critical', `${site.name} is unreachable — ${health.error}.`);
}

export function notifyMacOS(alerts) {
  if (process.env.NOTIFY_MACOS === '0' || process.platform !== 'darwin') return;
  if (alerts.length === 0) return;

  // One banner per batch. Ten sites failing at once should be one notification,
  // not ten stacked on top of each other.
  const title = alerts.length === 1 ? alerts[0].site : `${alerts.length} site alerts`;
  const body = alerts.map((a) => a.message).join(' | ');
  const sound = alerts.some((a) => a.severity === 'critical') ? 'Basso' : 'Ping';

  const script =
    `display notification ${quote(truncate(body, 240))} ` +
    `with title ${quote('Meerkat')} subtitle ${quote(truncate(title, 60))} ` +
    `sound name ${quote(sound)}`;

  execFile('osascript', ['-e', script], (err) => {
    if (err) console.error('[alerts] macOS notification failed:', err.message);
  });
}

function quote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
