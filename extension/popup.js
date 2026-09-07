import { DEFAULTS } from './defaults.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['enabled', 'corner', 'maxCards', 'opacity', 'meerkatUrl'];

const cfg = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };

$('enabled').checked = cfg.enabled;
$('corner').value = cfg.corner;
$('maxCards').value = cfg.maxCards;
$('opacity').value = cfg.opacity;
$('meerkatUrl').value = cfg.meerkatUrl;
$('blocklist').value = (cfg.blocklist ?? []).join('\n');

const save = (patch) => chrome.storage.sync.set(patch);

for (const id of FIELDS) {
  $(id).addEventListener('change', () => {
    const el = $(id);
    const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
    save({ [id]: value });
    refresh();
  });
}

$('blocklist').addEventListener('input', () => {
  const list = $('blocklist').value.split('\n').map((s) => s.trim()).filter(Boolean);
  save({ blocklist: list });
});

$('open').addEventListener('click', () => {
  chrome.tabs.create({ url: $('meerkatUrl').value.trim() || DEFAULTS.meerkatUrl });
});

async function refresh() {
  const url = ($('meerkatUrl').value.trim() || DEFAULTS.meerkatUrl).replace(/\/+$/, '');
  try {
    const res = await fetch(`${url}/api/state`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const live = (raw.sites ?? []).filter((s) => Number(s.activeNow) > 0);
    $('status').textContent = live.length
      ? `${raw.totals?.activeNow ?? 0} active · ${live.length} site${live.length > 1 ? 's' : ''} with viewers`
      : 'Meerkat reachable · nobody online, overlay hidden';
  } catch (err) {
    $('status').textContent = `Meerkat unreachable at ${url} — is it running?`;
  }
}

refresh();
