import { loadCredentials } from './auth.js';

const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const GSC = 'https://searchconsole.googleapis.com/webmasters/v3';

async function get(url) {
  const jwt = loadCredentials();
  const { token } = await jwt.getAccessToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* fall through to raw text below */
  }

  if (!res.ok) {
    const err = new Error(`${res.status} ${json?.error?.message || text.slice(0, 300)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json ?? {};
}

/** Every GA4 property the service account has been granted access to. */
export async function listGa4Properties() {
  const out = [];
  let pageToken = '';

  do {
    const url = `${ADMIN}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const page = await get(url);

    for (const account of page.accountSummaries ?? []) {
      for (const p of account.propertySummaries ?? []) {
        out.push({
          propertyId: p.property.split('/')[1],
          name: p.displayName,
          account: account.displayName,
        });
      }
    }
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);

  return out;
}

/**
 * A property's web stream carries the real site URL. Matching on that instead
 * of on the display name is what makes GA4↔GSC pairing reliable — display
 * names are whatever someone typed years ago.
 */
export async function propertyUrl(propertyId) {
  try {
    const res = await get(`${ADMIN}/properties/${propertyId}/dataStreams?pageSize=50`);
    const web = (res.dataStreams ?? []).find((s) => s.webStreamData?.defaultUri);
    return web?.webStreamData?.defaultUri ?? null;
  } catch {
    return null;
  }
}

/** Every Search Console property the service account can actually query. */
export async function listGscSites() {
  const res = await get(`${GSC}/sites`);
  return (res.siteEntry ?? [])
    .filter((s) => s.permissionLevel !== 'siteUnverifiedUser')
    .map((s) => ({ siteUrl: s.siteUrl, permission: s.permissionLevel }));
}

export function hostOf(value) {
  if (!value) return null;
  const lower = String(value).toLowerCase();
  const raw = lower.startsWith('sc-domain:')
    ? lower.slice('sc-domain:'.length)
    : lower.replace(/^https?:\/\//, '');
  return raw.replace(/^www\./, '').replace(/\/.*$/, '') || null;
}

/**
 * Pair each GA4 property with its Search Console counterpart by hostname.
 * Anything that doesn't pair is still returned, flagged, so nothing is
 * silently dropped from the config.
 */
export async function buildSites() {
  const [properties, gscSites] = await Promise.all([listGa4Properties(), listGscSites()]);

  const withUrls = await Promise.all(
    properties.map(async (p) => ({ ...p, url: await propertyUrl(p.propertyId) }))
  );

  // A site often has both a Domain and a URL-prefix property in Search Console.
  // Group every entry by host so the unmatched pass can't resurrect the runner-up
  // as a phantom second card, which would double-count its clicks in the totals.
  const gscByHost = new Map();
  for (const s of gscSites) {
    const host = hostOf(s.siteUrl);
    if (!host) continue;
    if (!gscByHost.has(host)) gscByHost.set(host, []);
    gscByHost.get(host).push(s);
  }

  // Prefer sc-domain entries: they cover every subdomain and protocol.
  const preferred = (entries) => entries.find((s) => s.siteUrl.startsWith('sc-domain:')) ?? entries[0];

  const usedGsc = new Set();
  const sites = withUrls.map((p) => {
    const host = hostOf(p.url);
    const candidates = host ? gscByHost.get(host) : null;
    const match = candidates ? preferred(candidates) : null;
    if (candidates) for (const c of candidates) usedGsc.add(c.siteUrl);

    return {
      name: p.name,
      ga4PropertyId: p.propertyId,
      gscSite: match?.siteUrl ?? null,
      url: p.url ?? null,
      _account: p.account,
      _matched: Boolean(match),
    };
  });

  // GSC properties with no GA4 counterpart still deserve a card — one per host,
  // not one per property variant.
  const leftoverHosts = new Map();
  for (const s of gscSites) {
    if (usedGsc.has(s.siteUrl)) continue;
    const host = hostOf(s.siteUrl);
    if (!host) continue;
    if (!leftoverHosts.has(host)) leftoverHosts.set(host, []);
    leftoverHosts.get(host).push(s);
  }

  const orphans = [...leftoverHosts.values()]
    .map(preferred)
    .map((s) => ({
      name: hostOf(s.siteUrl) ?? s.siteUrl,
      ga4PropertyId: null,
      gscSite: s.siteUrl,
      url: s.siteUrl.startsWith('sc-domain:') ? `https://${hostOf(s.siteUrl)}` : s.siteUrl,
      _account: null,
      _matched: false,
      _gscOnly: true,
    }));

  return { sites: [...sites, ...orphans], properties, gscSites };
}
