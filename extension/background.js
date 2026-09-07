import { DEFAULTS, isBlocked } from './defaults.js';

const CACHE_TTL_MS = 20_000;
let cache = { at: 0, payload: null };

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

/**
 * Meerkat refreshes its realtime numbers once a minute, so anything faster than
 * the TTL here is re-reading a value that cannot have changed. One fetch serves
 * every open tab.
 */
async function liveState(cfg) {
  const now = Date.now();
  if (cache.payload && now - cache.at < CACHE_TTL_MS) return cache.payload;

  let payload;
  try {
    const res = await fetch(`${cfg.meerkatUrl.replace(/\/+$/, '')}/api/state`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const sites = (raw.sites ?? [])
      .map((s) => ({ name: String(s.name ?? '').trim(), active: Number(s.activeNow) || 0, url: s.url || null }))
      .filter((s) => s.name && s.active > 0)
      .sort((a, b) => b.active - a.active || a.name.localeCompare(b.name));
    // Read the network figure from Meerkat rather than re-summing it here, so
    // there is one definition of the number and it matches the dashboard.
    payload = { ok: true, sites, total: Number(raw.totals?.activeNow) || 0 };
  } catch (err) {
    payload = { ok: false, sites: [], total: 0, error: String(err?.message ?? err) };
  }

  cache = { at: now, payload };
  return payload;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'meerkat:state') return;
  (async () => {
    const cfg = await settings();
    if (!cfg.enabled || isBlocked(msg.host, cfg.blocklist)) {
      sendResponse({ show: false, sites: [], total: 0, cfg });
      return;
    }
    const state = await liveState(cfg);
    sendResponse({
      show: state.ok && state.sites.length > 0,
      sites: state.sites.slice(0, Math.max(1, Number(cfg.maxCards) || 5)),
      total: state.total,
      cfg
    });
  })();
  return true;
});

// A settings change should take effect on the next tab poll, not a minute later.
chrome.storage.onChanged.addListener(() => {
  cache = { at: 0, payload: null };
});
