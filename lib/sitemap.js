const TIMEOUT_MS = 20000;
const MAX_URLS = 2000;

async function get(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Meerkat-Monitor/1.0' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extract(tag, xml) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function locs(xml) {
  return extract('loc', xml)
    .map((s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').trim())
    .filter(Boolean);
}

/**
 * The sitemap is the list of pages that are *supposed* to be indexed, which is
 * exactly what Search Console's performance report cannot tell you — a page
 * that was never indexed has no impressions and so never appears there. This
 * is how uncrawled pages become visible.
 */
export async function fetchSitemapUrls(siteUrl, robotsFirst = true) {
  const origin = new URL(siteUrl).origin;
  const candidates = [];

  if (robotsFirst) {
    const robots = await get(`${origin}/robots.txt`);
    if (robots) {
      for (const line of robots.split('\n')) {
        const m = line.match(/^\s*sitemap:\s*(\S+)/i);
        if (m) candidates.push(m[1]);
      }
    }
  }

  if (candidates.length === 0) {
    candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);
  }

  const seen = new Set();
  const urls = new Set();
  const queue = [...candidates];

  while (queue.length > 0 && urls.size < MAX_URLS) {
    const target = queue.shift();
    if (seen.has(target)) continue;
    seen.add(target);

    const xml = await get(target);
    if (!xml) continue;

    // A sitemap index nests other sitemaps; walk those before collecting pages.
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    if (isIndex) {
      for (const child of locs(xml)) {
        if (!seen.has(child) && queue.length < 60) queue.push(child);
      }
      continue;
    }

    for (const u of locs(xml)) {
      if (urls.size >= MAX_URLS) break;
      urls.add(u);
    }
  }

  return { urls: [...urls], sitemapsChecked: [...seen] };
}
