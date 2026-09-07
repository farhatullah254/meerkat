import { query } from './history.js';
import {
  siteInsights,
  networkTerms,
  indexingSummary,
  notIndexedPages,
  canonicalConflicts,
  siteAgeDays,
} from './insights.js';
import { rankReport } from './ranks.js';

/** Assumed reachable position for a striking-distance keyword, for sizing upside. */
const TARGET_POSITION_CTR = 0.06;

function table(headers, rows) {
  if (rows.length === 0) return '_none_\n';
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((c) => (c ?? '—')).join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}\n`;
}

/** Most recent stored snapshot per site — the unfiltered topline numbers. */
function topline(siteName) {
  return query(
    `SELECT * FROM snapshots WHERE site = ? ORDER BY ts DESC LIMIT 1`,
    siteName
  )[0] ?? null;
}

function searchTotals(siteName, days = 7) {
  const end = query(`SELECT MAX(date) d FROM gsc_pages WHERE site = ?`, siteName)[0]?.d;
  if (!end) return null;
  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (days - 1));

  return query(
    `SELECT SUM(clicks) clicks, SUM(impressions) impressions,
            SUM(position * impressions) / NULLIF(SUM(impressions),0) position
     FROM gsc_pages WHERE site = ? AND date BETWEEN ? AND ?`,
    siteName, start.toISOString().slice(0, 10), end
  )[0] ?? null;
}

/**
 * Rank every opportunity across the network by estimated clicks on the table.
 *
 * Two kinds, deliberately scored on the same axis so they compete honestly:
 * a CTR gap is clicks you already earned the right to and aren't collecting,
 * a striking-distance keyword is clicks you'd get by moving up the page. The
 * first is nearly always cheaper, which the score reflects.
 */
export function rankedOpportunities(sites, limit = 25) {
  const out = [];

  for (const site of sites) {
    const ins = siteInsights(site.name);

    for (const g of ins.ctrGaps) {
      out.push({
        site: site.name.trim(),
        kind: 'CTR',
        target: g.query,
        detail: `pos ${g.position}, ${g.impressions} impr, ${g.ctr}% CTR vs ~${g.expectedCtr}% expected`,
        upside: g.missedClicks,
        action: 'Rewrite title/meta to match this query',
      });
    }

    for (const s of ins.strikingDistance) {
      const current = s.impressions > 0 ? s.clicks / s.impressions : 0;
      const upside = Math.round((TARGET_POSITION_CTR - current) * s.impressions);
      if (upside < 2) continue;
      out.push({
        site: site.name.trim(),
        kind: 'RANK',
        target: s.query,
        detail: `pos ${s.position}, ${s.impressions} impr, ${s.clicks} clicks`,
        upside,
        action: 'Add or expand content section targeting this query',
      });
    }
  }

  return out.sort((a, b) => b.upside - a.upside).slice(0, limit);
}

export function buildDigest(sites, generatedAt) {
  const lines = [];
  const p = (s = '') => lines.push(s);

  const dataThrough = query(`SELECT MAX(date) d FROM gsc_pages`)[0]?.d ?? 'unknown';

  p(`# Meerkat — Network Digest`);
  p();
  p(`Generated ${generatedAt} · ${sites.length} sites · search data through ${dataThrough}`);
  p();
  p(`## How to read this`);
  p();
  p(
    `Each site is an independent micro-site on a shared template, so the sites are ` +
      `comparable to each other. **CTR** items are queries where the site already ranks ` +
      `well but is not being clicked — a title and meta description problem, and the ` +
      `cheapest fix available. **RANK** items are queries sitting just off page one where ` +
      `additional content could move them up. "Upside" is the estimated additional monthly ` +
      `clicks if the item is fixed, and is the basis for the ordering.`
  );
  p();
  p(
    `Positions are impression-weighted averages over the trailing 28 days. Click and ` +
      `impression counts in the per-query tables come from Search Console's query report, ` +
      `which omits low-volume anonymised queries, so they read slightly lower than the ` +
      `site totals above them. Treat query numbers as relative, not absolute.`
  );
  p();

  p(`## Network summary`);
  p();
  p(
    table(
      // Sessions, not users. User counts are de-duplicated per query by GA4, so
      // adding them across days or pages counts the same visitor many times.
      ['Site', 'Sessions 7d', 'Clicks 7d', 'Impressions 7d', 'Avg position', 'Live users now'],
      sites.map((s) => {
        const t = topline(s.name);
        const search = searchTotals(s.name);
        return [
          s.name.trim(),
          fmtNum(sumSessions7d(s.name)),
          fmtNum(search?.clicks),
          fmtNum(search?.impressions),
          search?.position ? search.position.toFixed(1) : '—',
          fmtNum(t?.active_now),
        ];
      })
    )
  );

  const opportunities = rankedOpportunities(sites);
  p(`## Priority actions across the network`);
  p();
  p(
    table(
      ['#', 'Site', 'Type', 'Query', 'Situation', 'Est. clicks', 'Action'],
      opportunities.map((o, i) => [
        i + 1,
        o.site,
        o.kind,
        `\`${o.target}\``,
        o.detail,
        `+${o.upside}`,
        o.action,
      ])
    )
  );

  p(`## Indexing coverage`);
  p();
  p(
    `Every URL in each site's sitemap, checked against Google's index. This is the ` +
      `question the performance report cannot answer: a page that was never indexed has ` +
      `no impressions, so it never appears there at all.`
  );
  p();
  p(
    `**Legal boilerplate is excluded** — about, contact, DMCA, privacy, terms, disclaimer. ` +
      `Those pages are roughly half of every sitemap here and were the large majority of ` +
      `unindexed URLs, while being worth nothing in search. Counting them made healthy ` +
      `sites look broken and buried the real content gaps. Everything below is content.`
  );
  p();
  p(
    `Weigh each figure against the site's age. Every site in this network launched within ` +
      `the last few weeks, and a site under two weeks old with pages still pending is ` +
      `behaving normally rather than failing.`
  );
  p();
  p(
    table(
      ['Site', 'Age (days)', 'Indexed', 'Not indexed', 'Canonical conflicts', 'Indexed pages missing schema'],
      sites.map((s) => {
        const ix = indexingSummary(s.name);
        if (!ix) return [s.name.trim(), siteAgeDays(s.name) ?? '—', '—', '—', '—', '—'];
        const pct = ix.checked ? Math.round((ix.indexed / ix.checked) * 100) : 0;
        return [
          s.name.trim(),
          siteAgeDays(s.name) ?? '—',
          `${ix.indexed}/${ix.checked} (${pct}%)`,
          ix.notIndexed,
          ix.canonicalIssues,
          ix.noSchema,
        ];
      })
    )
  );

  const missing = sites.flatMap((s) =>
    notIndexedPages(s.name, { limit: 50 }).map((r) => [
      s.name.trim(),
      r.url.replace(/^https?:\/\/[^/]+/, ''),
      r.coverage_state,
      explainState(r.coverage_state),
    ])
  );
  p(`### Pages not indexed`);
  p();
  p(table(['Site', 'Page', 'State', 'What to do'], missing));

  p(`### Why pages aren't indexed`);
  p();
  const stateTotals = new Map();
  for (const s of sites) {
    for (const row of indexingSummary(s.name)?.byState ?? []) {
      stateTotals.set(row.state, (stateTotals.get(row.state) ?? 0) + row.n);
    }
  }
  p(
    table(
      ['Coverage state', 'Pages', 'What it means'],
      [...stateTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([state, n]) => [state, n, explainState(state)])
    )
  );

  p(`## Rank tracking`);
  p();
  p(
    `The five queries earning each site the most clicks over the last 7 days, with ` +
      `today's position against the trailing 7-day average. Positions are impression-weighted ` +
      `averages of where real users actually saw the site, split by country because a ` +
      `blended average hides markets that are performing very differently.`
  );
  p();
  for (const site of sites) {
    const ranks = rankReport(site.name);
    if (ranks.length === 0) continue;
    p(`**${site.name.trim()}**`);
    p();
    p(
      table(
        ['Query', 'Today', '7-day avg', 'Change', 'Clicks today', 'By country (7d)'],
        ranks.map((r) => [
          `\`${r.query}\``,
          r.position !== null
            ? `#${r.position}`
            : r.daysSinceSeen !== null
              ? `not shown (last seen ${r.daysSinceSeen}d ago at #${r.lastSeenPosition})`
              : 'not shown',
          r.priorPosition !== null ? `#${r.priorPosition}` : '—',
          r.change === null
            ? '—'
            : r.change > 0
              ? `${r.change} better`
              : r.change < 0
                ? `${Math.abs(r.change)} worse`
                : 'no change',
          r.clicks,
          r.byCountry.map((c) => `${c.label} #${c.position}`).join(', ') || '—',
        ])
      )
    );
  }

  p(`## Per-site detail`);
  p();

  for (const site of sites) {
    const ins = siteInsights(site.name);
    const search = searchTotals(site.name);
    const hasAnything =
      ins.strikingDistance.length ||
      ins.ctrGaps.length ||
      ins.zeroClick.length ||
      ins.topPages.length;

    p(`### ${site.name.trim()}`);
    p();
    p(`${site.url ?? '—'} · GA4 ${site.ga4PropertyId ?? 'none'} · GSC ${site.gscSite ?? 'none'}`);
    p();

    if (!hasAnything) {
      p(`_No search data yet — the site has no meaningful impressions in the last 28 days._`);
      p();
      continue;
    }

    p(
      `7-day search: ${fmtNum(search?.clicks)} clicks, ${fmtNum(search?.impressions)} impressions, ` +
        `avg position ${search?.position ? search.position.toFixed(1) : '—'}`
    );
    p();

    if (ins.ctrGaps.length) {
      p(`**Ranking but not clicked** — rewrite titles and meta descriptions`);
      p();
      p(
        table(
          ['Query', 'Position', 'Impressions', 'CTR', 'Expected', 'Missed clicks'],
          ins.ctrGaps.map((g) => [
            `\`${g.query}\``, g.position, g.impressions, `${g.ctr}%`, `${g.expectedCtr}%`, g.missedClicks,
          ])
        )
      );
    }

    if (ins.strikingDistance.length) {
      p(`**Just off page one** — content opportunities`);
      p();
      p(
        table(
          ['Query', 'Position', 'Impressions', 'Clicks'],
          ins.strikingDistance.map((s) => [`\`${s.query}\``, s.position, s.impressions, s.clicks])
        )
      );
    }

    if (ins.zeroClick.length) {
      p(`**Shown, never clicked**`);
      p();
      p(
        table(
          ['Query', 'Impressions', 'Position'],
          ins.zeroClick.map((z) => [`\`${z.query}\``, z.impressions, z.position])
        )
      );
    }

    if (ins.movement.falling.length) {
      p(`**Losing clicks week over week**`);
      p();
      p(
        table(
          ['Query', 'This week', 'Last week', 'Change', 'Position'],
          ins.movement.falling.map((m) => [
            `\`${m.query}\``, m.current, m.previous, m.delta, m.position,
          ])
        )
      );
    }

    if (ins.deadPages.length) {
      p(`**Pages earning impressions but no clicks**`);
      p();
      p(
        table(
          ['Page', 'Impressions', 'Position'],
          ins.deadPages.map((d) => [d.page, d.impressions, d.position])
        )
      );
    }

    if (ins.topPages.length) {
      p(`**Top pages**`);
      p();
      p(
        table(
          ['Page', 'Clicks', 'Impressions', 'Position'],
          ins.topPages.slice(0, 5).map((t) => [t.page, t.clicks, t.impressions, t.position])
        )
      );
    }

    if (ins.countries.length) {
      p(
        `**Audience**: ` +
          ins.countries.map((c) => `${c.country} (${c.sessions})`).join(', ')
      );
      p();
    }

    if (ins.sources.length) {
      p(
        `**Sources**: ` +
          ins.sources.map((s) => `${s.source}/${s.medium} (${s.sessions})`).join(', ')
      );
      p();
    }
  }

  p(`## Network-wide search vocabulary`);
  p();
  p(
    `Query terms aggregated across all sites. Because every site runs the same template ` +
      `against a different app, the shared modifiers show which phrasings actually earn ` +
      `clicks — useful when choosing titles and headings for a new site.`
  );
  p();
  p(
    table(
      ['Term', 'Clicks', 'Impressions', 'CTR', 'Avg position', 'Queries'],
      networkTerms().map((t) => [
        `\`${t.term}\``, t.clicks, t.impressions, `${t.ctr}%`, t.position, t.queries,
      ])
    )
  );

  return lines.join('\n');
}

function sumSessions7d(siteName) {
  const end = query(`SELECT MAX(date) d FROM ga4_pages WHERE site = ?`, siteName)[0]?.d;
  if (!end) return null;
  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 6);
  return query(
    `SELECT SUM(sessions) n FROM ga4_pages WHERE site = ? AND date BETWEEN ? AND ?`,
    siteName, start.toISOString().slice(0, 10), end
  )[0]?.n ?? null;
}

function explainState(state) {
  const s = String(state).toLowerCase();
  if (s.includes('unknown to google')) {
    return 'Google has never seen this URL. Check internal linking and that the sitemap lists this exact URL form.';
  }
  if (s.includes('crawled')) {
    return 'Google fetched it and chose not to index. A quality or thin-content judgement.';
  }
  if (s.includes('discovered')) {
    return 'Google knows about it but has not crawled yet. Usually crawl-budget or low priority.';
  }
  if (s.includes('alternate') || s.includes('canonical')) {
    return 'Google folded it into another URL as a duplicate.';
  }
  if (s.includes('noindex')) return 'Blocked by a noindex directive.';
  if (s.includes('redirect')) return 'Redirects elsewhere, so the target is indexed instead.';
  if (s.includes('not found') || s.includes('404')) return 'Returns 404 — remove it from the sitemap.';
  return '';
}

function fmtNum(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}
