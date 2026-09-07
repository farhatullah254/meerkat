# Meerkat

One local dashboard for all the M&F sites — GA4 realtime + daily users on one tab,
Search Console clicks on another, with macOS alerts when something breaks.

Runs entirely on your Mac. Nothing is hosted, nothing leaves the machine except the
API calls to Google.

---

## Setup

### 1. Create the Google service account

1. [console.cloud.google.com](https://console.cloud.google.com) → create a project (e.g. `ake-analytics`)
2. **APIs & Services → Library** → enable all three:
   - Google Analytics Data API
   - Google Search Console API
   - Google Analytics Admin API *(only needed for `npm run discover`)*
3. **IAM & Admin → Service Accounts → Create service account** → name it, skip the optional
   role and user steps → **Done**
4. Open the account → **Keys → Add key → Create new key → JSON** → download
5. Save that file into this folder as `service-account.json`
6. Copy the account's email — it looks like `something@your-project.iam.gserviceaccount.com`

### 2. Grant it access to your properties

**This step is unavoidable and there is no API shortcut for it.** A service account is a
separate identity from the Google account that created the Cloud project — it inherits
nothing. It can only see properties it has been explicitly added to.

For **each** GA4 property: Admin → Property Access Management → **+** → paste the service
account email → role **Viewer** → Add.

For **each** Search Console property: Settings → Users and permissions → Add user → paste
the same email → permission **Restricted** → Add.

> If you'd rather not do this per property, the alternative is OAuth — signing in as your
> own Google account, which sees everything it already owns with no grants at all. This
> build uses the service account by choice; switching is a contained change to `lib/auth.js`.

### 3. Configure

```bash
cp .env.example .env
```

Point `GOOGLE_APPLICATION_CREDENTIALS` at your downloaded key, then let the app write
its own site list:

```bash
npm run discover          # preview what the service account can see
npm run discover -- --write   # save it to config.json
```

Discovery asks Google for every GA4 property and Search Console site the account can
reach, reads each property's web stream to get its real URL, and pairs GA4 to GSC by
hostname. Re-run it whenever you add a site — your custom names and per-site thresholds
are preserved across runs, and the old file is backed up to `config.json.bak`.

Anything it can't pair is still written out and flagged, so nothing goes missing.

To do it by hand instead, `cp config.example.json config.json` and list your sites:

```json
{
  "sites": [
    {
      "name": "Site One",
      "ga4PropertyId": "123456789",
      "gscSite": "sc-domain:siteone.com",
      "url": "https://siteone.com"
    }
  ]
}
```

- **`ga4PropertyId`** — the numeric ID in GA4 → Admin → Property Settings.
  Not the `G-XXXXXXX` measurement ID; the app will reject that with a clear error.
- **`gscSite`** — must match Search Console exactly. `sc-domain:example.com` for a
  Domain property, or the full `https://example.com/` (trailing slash) for a URL-prefix property.
- **`url`** — used for the uptime check.

### 4. Verify access before you trust the dashboard

```bash
npm run check
```

This hits every property and tells you exactly which grants are missing, so you aren't
guessing from empty cards. Fix anything it flags, then re-run.

### 5. Run

```bash
npm start
```

Open <http://localhost:3000>.

---

## What each number means

GA4 de-duplicates users per query, which is why this dashboard is careful about
which metric it shows where. Summing "users" across hours or across sites would
count the same person many times.

| Field | Source | Notes |
|---|---|---|
| **Active right now** | GA4 Realtime API | Users in the last 30 min. Same number the GA4 Realtime card shows. Refreshes every 60s. |
| **Users today / yesterday** | GA4 `totalUsers` by date | Correct unique counts per day. Today is partial and still settling. |
| **7-day users** | GA4 `totalUsers`, 7-day range | Unique across the whole week — deliberately *not* the sum of seven daily figures. |
| **Sessions 24h** | GA4 sessions by hour, last 24 buckets | Sessions are additive, so this is a true rolling 24h number. |
| **Pace** | today's sessions vs same hours over 14 days | Compares like with like — a part-day against the same part of previous days. |
| **Clicks last 24h** | GSC `HOUR` dimension, `HOURLY_ALL` | Genuinely same-day. Not every property serves it; the card says so if yours doesn't. |
| **Clicks / impressions 7d** | GSC `DATE` dimension, `ALL` | Fresh but not final — Google revises the last ~2 days upward. |

The totals row sums **sessions and clicks** (additive) and **active-now** counts. Across
ten separate properties there's no shared user identity, so cross-site user totals
would be meaningless and aren't shown.

---

## Alerts

Three rules, evaluated on every poll, delivered as macOS notification banners and
listed on the Alerts tab.

| Rule | Fires when | Guard |
|---|---|---|
| **Traffic spike / drop** | Today's sessions are unusual *for this site* — measured in standard deviations against its own scatter | Also needs ≥8 sessions of absolute movement and ≥5 days of history |
| **Traffic sustained drop** | Last complete week is ≥60% below the week before | Only if the prior week had ≥20 sessions |
| **GSC clicks collapsed** | 24h clicks fall ≥2σ below the site's own 7-day pattern | Also needs ≥5 clicks of absolute movement |
| **GSC sustained drop** | Last week's clicks are ≥60% below the week before | Only if the prior week had ≥15 clicks |
| **Site unreachable** | Non-2xx or timeout on **two consecutive** checks | Single blips are ignored |

**Why there are two drop rules for each source.** The z-score rules measure a site
against its own recent scatter, which makes them good at catching a sudden fall and
blind to a slow one — once a decline has run for several days it is *inside* the
reference window, dragging the mean down and widening the deviation until the collapse
looks normal. A real site in this network bled from 40 clicks a day to zero without
tripping anything. The sustained rules compare the last complete week against the week
before it, so the reference can never be contaminated by the damage being measured.

The absolute floors exist so low-traffic sites don't page you over the difference
between two visitors and five. Tune the thresholds in `.env` globally, or per site in
`config.json`:

```json
{
  "name": "Site One",
  "thresholds": { "trafficDeviationPct": 70, "gscDropPct": 40, "gscMinBaseline": 25 }
}
```

Each rule has a **6-hour cooldown per site** (`ALERT_COOLDOWN_HOURS`), so one ongoing
incident produces one banner, not one every fifteen minutes.

**Two things worth knowing:**

- Spike/drop alerts stay quiet for the first several days. The baseline comes from your
  own stored history, and until there's enough of it the cards read
  *"Baseline building"*. That's expected, not a failure.
- This is a local app, so alerts only fire while `npm start` is running. If you want
  them while you're away from the Mac, say so and I'll add a Telegram sender —
  it's about twenty lines in `lib/alerts.js`.

---

## Analysis data and the AI digest

Beyond the live dashboard, the app harvests **dimensional** data daily — the queries
each site ranks for, the pages that earn clicks, landing pages, countries and channels —
and stores it historically in SQLite. That is what makes real analysis possible; the
topline numbers on the dashboard cannot tell you *why* one site outperforms another.

### Adding a site later

```bash
npm run sync                 # find new properties, add them, backfill, rebuild digest
npm run sync -- --dry-run    # preview without writing anything
```

The running server does the same reconcile on its daily cycle, so a newly-granted
property appears within 24 hours on its own; `npm run sync` just makes it immediate.
It is append-only — a property that disappears from discovery is treated as a revoked
grant rather than a deleted site, so its history is never thrown away. Removals stay a
manual edit to `config.json`.

```bash
npm run harvest              # pull 28 days of query/page data for every site
npm run harvest -- --days=7  # lighter incremental pull
npm run digest               # write the analysis brief
```

Both run automatically once every 20 hours while the server is up, so in normal use you
never invoke them by hand. The 28-day window is re-pulled each time on purpose: Google
revises the last ~48 hours upward, and the primary keys turn a re-pull into an update
rather than a duplicate.

### The digest

`npm run digest` writes `data/digests/YYYY-MM-DD.md` and `data/digests/latest.md`. It is
written to be handed to an AI — paste it into a conversation, or point a skill at
`latest.md` — and contains:

- **Network summary** — every site side by side
- **Priority actions** — every opportunity across all 10 sites, ranked by estimated
  clicks available, so the list tells you what to work on first
- **Per-site detail** — CTR gaps, striking-distance keywords, zero-click queries,
  falling queries, dead pages, audience and channels
- **Network-wide vocabulary** — which query terms earn clicks across the whole network

Two opportunity types, scored on the same axis so they compete honestly:

| Type | Meaning | Fix |
|---|---|---|
| **CTR** | Ranks well, isn't clicked | Rewrite title and meta description — cheapest win available |
| **RANK** | Sits just off page one | Add or expand content targeting the query |

### Indexing coverage

Every content URL in each site's sitemap is checked against Google's index daily via the
URL Inspection API. This answers the one question the performance report structurally
cannot: a page that was never indexed has no impressions, so it never appears there.

**Legal boilerplate is skipped** — about, contact, dmca, privacy-policy, terms,
disclaimer, download. Those are roughly half of every sitemap in this network and were
the large majority of unindexed URLs, while being worth nothing in search. Counting them
made healthy sites look broken. Skipping them at inspection time also halves the API
calls. `INSPECT_UTILITY_PAGES=1` re-enables them; `isUtilityPage()` in `lib/insights.js`
defines the set.

Read the result alongside `siteAgeDays()` — a site under two weeks old with pages still
pending is behaving normally.

Stored per URL: `coverageState`, `indexingState`, `pageFetchState`, `lastCrawlTime`,
Google's chosen canonical vs the declared one, which sitemap it came from, and whether
structured data was detected. Quota is 2,000 URLs per property per day; the run is capped
at 200 per site.

`url_inspection_history` keeps a daily trail, so "this page fell out of the index on the
9th" stays answerable.

### Rank tracking

The five queries earning each site the most clicks over the trailing 7 days are tracked
daily — chosen by clicks rather than impressions, because impressions reward terms the
site appears for but nobody wants.

Positions are stored blended and split by **device** and **country**. The split matters:
a blended average across the US, Indonesia and Pakistan can read "position 9" while
actually being 4 in one market and 20 in another.

Current position is a **3-day impression-weighted average**, not a single day. Search
Console's most recent day is partial and gets revised for up to 48 hours, so a one-day
reading regularly shows zero impressions for a keyword that is ranking fine.

Two alerts: `rank_drop` (≥5 places) and `rank_lost` (no impressions in 3 days for a
keyword that was in the top 30 last week).

> **On scraping Google for "more accurate" positions:** it isn't more accurate. Google
> personalises by IP, location, device and history — incognito changes none of that, so a
> scraped position is one sample from your location, while Search Console is thousands of
> samples from your actual audience. Google also hardened against automated access in
> January 2025 (JS execution, TLS fingerprinting, behavioural analysis), and automated
> querying violates its Terms of Service. If competitor positions and SERP features are
> genuinely needed later, a paid SERP API is the route — not a headless browser.

### Insight thresholds

These sites are low-volume, so the defaults are tuned accordingly. Raise them in `.env`
if the lists get noisy:

```
INSIGHT_MIN_IMPRESSIONS=5          # floor for striking-distance keywords
INSIGHT_CTR_MIN_IMPRESSIONS=15     # floor for CTR gap detection
INSIGHT_MIN_MISSED_CLICKS=2        # minimum upside before an item is listed
INSIGHT_TERM_MIN_IMPRESSIONS=30    # floor for network vocabulary
```

### Querying the data yourself

Everything lives in `data/ake-analytics.db` — plain SQLite, no server needed:

```bash
sqlite3 data/ake-analytics.db "SELECT query, SUM(clicks) c, SUM(impressions) i FROM gsc_queries WHERE site LIKE 'cooking%' GROUP BY query ORDER BY i DESC LIMIT 20"
```

Tables: `gsc_queries`, `gsc_pages`, `ga4_pages`, `ga4_countries`, `ga4_sources`,
`snapshots`, `alerts`, `harvest_log`.

> **Running experiments against the alert engine?** Set `AKE_DB_PATH=/tmp/scratch.db`
> first. Calling the rules writes real rows — synthetic test alerts otherwise show up
> in your dashboard as if they were genuine.

---

## Polling and quotas

| Job | Interval |
|---|---|
| GA4 realtime | 60s |
| GA4 daily + Search Console | 15 min |
| Uptime check | 5 min |

That's 60 realtime requests per property per hour against a limit of roughly 1,250,
plus 4 batched report calls. Ten sites sit at a few percent of the free quota.

---

## Files

```
config.json          your sites (gitignored)
service-account.json Google key (gitignored)
.env                 paths and alert thresholds (gitignored)
server.js            polling loops + API
lib/auth.js          service account JWT, error unwrapping
lib/ga4.js           realtime + batched daily/hourly reports
lib/gsc.js           24h hourly + 28-day daily series
lib/health.js        uptime check
lib/history.js       SQLite store (node:sqlite, no native build)
lib/alerts.js        rules, cooldown, macOS notifier
lib/config.js        config loading and validation
lib/discover.js      GA4 Admin + GSC property enumeration and pairing
lib/harvest.js       daily dimensional pull into SQLite
lib/insights.js      striking distance, CTR gaps, dead pages, network vocabulary
lib/digest.js        markdown brief assembly
public/index.html    the dashboard
scripts/discover.js  writes config.json from what Google reports
scripts/harvest.js   manual harvest
scripts/digest.js    manual digest
scripts/check-access.js  permission verifier
data/                SQLite file, 120-day retention
data/digests/        generated analysis briefs
```

## Troubleshooting

**`403` on a GA4 property** — the service account isn't on that property yet, or was
added to the Account rather than the Property. Add it at Property level.

**`403` on Search Console** — added in GSC, but to a different property than the string
in `config.json`. Domain and URL-prefix properties are separate entries.

**`404` on Search Console** — the `gscSite` string doesn't match. Copy it from the GSC
property switcher exactly.

**Cards show `—` everywhere** — run `npm run check`; it will name the problem.

**`npm run discover` finds nothing** — the grants in step 2 haven't been done, or were
applied to a different Google account than the service account email. The script prints
the exact email to add.

**Discovery fails with `SERVICE_DISABLED`** — the Analytics Admin API isn't enabled.
The error prints the direct activation link.

**No macOS banners** — first alert triggers a permission prompt. Check
System Settings → Notifications → Script Editor is allowed. Set `NOTIFY_MACOS=0`
to turn banners off and rely on the Alerts tab.
