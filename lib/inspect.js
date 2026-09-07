import { googlePost } from './auth.js';

const ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

/**
 * Quota is 2,000 URLs per property per day and 600 per minute. These sites are
 * far smaller than that, so the cap below exists to keep a runaway sitemap from
 * burning the budget rather than because we expect to approach it.
 */
const DEFAULT_MAX = 200;
const PAUSE_MS = 120;

/**
 * PASS is Google's own judgement that the URL is on the index, so it decides.
 * coverageState is free text that varies by case and gets reworded over time,
 * so it is only consulted when there is no verdict — and "not indexed" has to
 * be ruled out first, since it contains the word "indexed".
 */
export function isIndexed(result) {
  if (result.verdict === 'PASS') return true;
  if (result.verdict === 'FAIL') return false;

  const state = String(result.coverageState ?? '').toLowerCase();
  if (!state) return false;
  if (state.includes('not indexed')) return false;
  return state.includes('indexed');
}

export async function inspectUrl(siteUrl, pageUrl) {
  const res = await googlePost(ENDPOINT, { siteUrl, inspectionUrl: pageUrl });
  const r = res.inspectionResult ?? {};
  const idx = r.indexStatusResult ?? {};

  const googleCanonical = idx.googleCanonical ?? null;
  const userCanonical = idx.userCanonical ?? null;

  return {
    url: pageUrl,
    verdict: idx.verdict ?? null,
    coverageState: idx.coverageState ?? null,
    robotsTxtState: idx.robotsTxtState ?? null,
    indexingState: idx.indexingState ?? null,
    pageFetchState: idx.pageFetchState ?? null,
    lastCrawlTime: idx.lastCrawlTime ?? null,
    googleCanonical,
    userCanonical,
    // Google choosing a different canonical than the page declares is a quiet
    // killer on templated sites — the page is fine, it just isn't the one being
    // ranked, and nothing in the performance report says so.
    canonicalMismatch:
      Boolean(googleCanonical && userCanonical && googleCanonical !== userCanonical),
    sitemaps: (idx.sitemap ?? []).join(', ') || null,
    richResultsVerdict: r.richResultsResult?.verdict ?? null,
    richResultsIssues: countRichIssues(r.richResultsResult),
    inspectionLink: r.inspectionResultLink ?? null,
  };
}

function countRichIssues(rich) {
  if (!rich?.detectedItems) return 0;
  let n = 0;
  for (const type of rich.detectedItems) {
    for (const item of type.items ?? []) n += (item.issues ?? []).length;
  }
  return n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function inspectUrls(siteUrl, urls, { max = DEFAULT_MAX, onProgress } = {}) {
  const targets = urls.slice(0, max);
  const results = [];
  const errors = [];

  for (let i = 0; i < targets.length; i++) {
    try {
      results.push(await inspectUrl(siteUrl, targets[i]));
    } catch (err) {
      errors.push({ url: targets[i], error: err.message });
      // A 429 means the per-minute ceiling was hit; anything else is that URL's
      // problem, not the run's, so keep going.
      if (err.status === 429) await sleep(5000);
    }
    onProgress?.(i + 1, targets.length);
    await sleep(PAUSE_MS);
  }

  return { results, errors, skipped: Math.max(0, urls.length - targets.length) };
}
