# LinkedIn Lead Machine

A personal LinkedIn lead engine for one operator on one account. Two motors that
share the same safety rails (warmup gate, rate limits, work hours, circuit breaker):

- **Inbound (primary, LeadPanther-style):** generate a lead magnet + posts →
  publish → capture everyone who comments the trigger word → DM the magnet → gate
  the email → hand the lead to your CRM. A small bandit learns which post hooks
  convert. **This is the focus.**
- **Outbound (secondary):** connection request → personalized DM → timed
  follow-ups, with an optional email fallback.

> AI for all generation is **Claude via your Max-plan CLI** (Opus for magnets/posts,
> Sonnet for DMs). The "continuously learning" part is an honest outcome-tracking
> bandit — no separate ML engine. See `ROADMAP.md` for the pivot plan.

---

## Inbound engine (the primary motor)

```
ContentGenerator (Claude)                Capture server (gated page)
   magnet + posts  ──►  publish post ──►  comment "guide"  ──►  DM the magnet link
                                                │                      │
                                          engagement captured     click + email tracked
                                                │                      │
                                     auto-accept their invite     email → CRM (Pipedrive)
```

```bash
# 1) generate a magnet and some posts (Claude if PERSONALIZER=claude-cli)
npm run gen-magnet -- "cold email deliverability"
npm run gen-posts -- 1 4 --schedule         # 4 posts for magnet #1, spread over days
npm run gen-posts -- 1 4 --schedule --learn # ...or let the bandit pick the hooks

# 2) run the capture server (put it behind a public URL; set CAPTURE_BASE_URL)
npm run capture-server

# 3) run the inbound loop (publish, scan comments, deliver, capture)
npm run inbound-tick          # one tick (good for cron)
npm run inbound-loop          # continuous, human-like pacing
```

Reading comments / pending invites is far more reliable via the **Unipile** driver
(real API) than browser scraping — recommended for the inbound flow.

Captured / taken-over leads are pushed to **Pipedrive** automatically
(`CRM_PROVIDER=pipedrive`, `PIPEDRIVE_API_TOKEN`); on email capture and/or on reply
(`CRM_CREATE_ON`). `npm run status` shows posts, engagements, click/capture/CRM
totals, and per-hook performance.

---

## ⚠️ Read first — the honest risk picture

LinkedIn outbound is the **most ban-prone** kind of automation. This tool is built
to minimize that, but it cannot eliminate it. Three rules are **non-negotiable**:

1. **Warm up the account for ~30 days manually first** (post, comment, connect by
   hand). The machine **refuses to send anything** until `WARMUP_UNTIL` has passed.
2. **Use a residential proxy that matches your usual login location.** On a
   datacenter VPS, LinkedIn flags the session fast without this. A sudden location
   change is itself a red flag.
3. **Start slow.** Defaults ramp from ~5 invites/day up to ~15 over the first week.
   Don't raise the caps early. LinkedIn's real weekly limit is ~100.

If LinkedIn restricts the account, you lose it. Strongly consider testing on a
secondary account before pointing this at a profile you care about.

---

## How it works

```
Lead source (CSV: Sales Nav / Apollo export)
      │  scripts/import-leads.js
      ▼
SQLite pipeline:  new → invited → connected → messaged → followup_1 → followup_2 → done
                                                   └────────────► replied (you take over)
      │
   Sequencer (one human-like action per "tick")
      ├─ access layer:  Playwright (real) | Unipile (hosted) | Mock (dry-run)
      ├─ email fallback: Instantly | Mock | none   (optional second channel)
      ├─ personalizer:  Claude via your Max plan (headless CLI) | local templates
      ├─ rate limiter:  daily/weekly/hourly caps + work hours + ramp-up
      └─ notifier:      console | Telegram  (pings you on replies)
```

Each **tick** does all safe bookkeeping (detect replies, detect accepted invites,
withdraw stale invites, expire old sequences) plus **at most one outbound send**,
to stay human-like. The runner loops with randomized delays inside your configured
work hours.

### Ban-safety built in

- **Throttled checks.** Reply/acceptance detection is the expensive part on a real
  browser (one navigation per lead). The machine re-checks any given lead at most
  every `CHECK_INTERVAL_HOURS` and only `MAX_CHECKS_PER_TICK` leads per tick — so a
  tick never turns into dozens of page loads.
- **Note-budget aware.** LinkedIn caps *noted* invites hard (free accounts ~5/month).
  Once `MAX_NOTED_INVITES_PER_MONTH` is spent, invites keep going out **without a
  note** instead of silently failing.
- **Stale-invite withdrawal.** Invites pending longer than `WITHDRAW_INVITE_AFTER_DAYS`
  are withdrawn (a large pile of open invites is itself a ban signal), bounded per tick.
- **Circuit breaker.** If the driver hits a checkpoint / auth wall, all sending stops,
  you get an alert, and the machine stays dark for `SAFETY_BREAKER_COOLDOWN_HOURS`
  (persisted, so even cron `--once` runs respect it). Log in manually to clear it.

## Cost: ~10 €/month

| Part | Choice | Cost |
|------|--------|------|
| Server | your VPS | 0 |
| DB | SQLite (built-in) | 0 |
| LLM | Claude **Max plan** via `claude` CLI | 0 |
| LinkedIn access | Playwright (browser) | 0 |
| **Residential proxy** (matching your location) | required on a VPS | ~10 € |
| Notifications | Telegram/console | 0 |

Later, swap the access layer to **Unipile** (~49 €/mo) for stability — only the
driver changes, the rest stays.

---

## Setup

```bash
# 1. Configure
cp .env.example .env
# edit .env: set SENDER_NAME, VALUE_PROP, PROXY_*, TIMEZONE, work hours…
# keep LINKEDIN_DRIVER=mock and PERSONALIZER=template for the first dry-runs

# 2. Dry-run (no real LinkedIn, no AI) — verify the pipeline
node scripts/import-leads.js your-leads.csv     # CSV needs a linkedin_url column
node src/runner.js --once                        # one tick
node scripts/status.js                           # see the pipeline

# 3. Tests
npm test
```

### Going live (on your server, after warmup)

```bash
# install the browser driver
npm install playwright && npx playwright install chromium

# one-time manual login -> saves a reusable session
node scripts/login.js

# flip to real mode in .env:
#   LINKEDIN_DRIVER=playwright
#   PERSONALIZER=claude-cli        (uses your Claude Max plan via the `claude` CLI)
#   WARMUP_UNTIL=<a past date>      (only after 30 days of manual warmup)
#   PROXY_SERVER / PROXY_USERNAME / PROXY_PASSWORD  (residential, your location)

# run continuously (loops with human-like delays inside work hours)
node src/runner.js
# …or run one tick from cron every ~20–40 min:
#   */30 9-17 * * 1-5  cd /path && node src/runner.js --once
```

## Configuration

All settings live in `.env` (see `.env.example` for the full list). Key ones:

- **`WARMUP_UNTIL`** — machine refuses to send before this date. Your safety switch.
- **Rate limits** — `MAX_INVITES_PER_DAY/WEEK/HOUR`, `RAMP_UP_*`. Conservative defaults.
- **`WORK_HOURS_*`, `WORK_DAYS`** — only acts inside this window.
- **`MIN/MAX_DELAY_SECONDS`** — random pause between actions.
- **Sequence timing** — `DAYS_BEFORE_FIRST_DM`, `DAYS_BEFORE_FOLLOWUP_1/2`, `DAYS_BEFORE_DONE`.
- **Check throttling** — `CHECK_INTERVAL_HOURS`, `MAX_CHECKS_PER_TICK`.
- **Invites** — `ATTACH_NOTE`, `MAX_NOTED_INVITES_PER_MONTH`, `WITHDRAW_INVITE_AFTER_DAYS`, `MAX_WITHDRAWALS_PER_TICK`.
- **`SAFETY_BREAKER_COOLDOWN_HOURS`** — how long to stay dark after a detected checkpoint.
- **`PERSONALIZER`** — `template` (offline) or `claude-cli` (your Max plan).
- **`SENDER_NAME`, `SENDER_ROLE`, `VALUE_PROP`** — context fed to the personalizer.

## Lead CSV format

```csv
linkedin_url,name,headline,company,role,location,email,notes
https://www.linkedin.com/in/jane-doe,Jane Doe,Head of Sales,Acme,Head of Sales,Berlin,jane@acme.com,met at event
```

Only `linkedin_url` is required. `email` is optional and enables the email
fallback channel for that lead. Re-importing the same URL updates the lead.

## Project layout

```
src/
  config.js              env + .env loader
  db/{db,leads}.js       SQLite + lead repository / status machine
  linkedin/              access layer: LinkedInClient (interface), MockClient,
                         PlaywrightClient, UnipileClient, index.js (factory)
  email/                 fallback channel: EmailClient (interface), MockEmailClient,
                         InstantlyClient, index.js (factory)
  crm/                   CRM hand-off: CrmClient (interface), PipedriveClient,
                         MockCrmClient, index.js (factory + syncEngagementToCrm)
  inbound/               contentGenerator, inboundSequencer, learning (bandit)
  server/captureServer   gated landing pages + email capture + click tracking
  db/{magnets,posts,engagements}.js   inbound repositories
  ai/{claude,personalizer}.js   Claude CLI plumbing + DM templates
  inboundRunner.js       inbound entry point (--once or loop)
  core/{rateLimiter,sequencer}.js   limits + the brain
  notify/notifier.js     console / Telegram
  runner.js              entry point (--once or loop)
scripts/                 import-leads, status, login
test/                    node:test suite (run: npm test)
```

## Swapping to Unipile

`src/linkedin/UnipileClient.js` implements the same `LinkedInClient` interface via
Unipile's hosted API (it holds the LinkedIn session for you — no local browser,
login script, or proxy). To switch: set `LINKEDIN_DRIVER=unipile` and fill in
`UNIPILE_DSN`, `UNIPILE_API_KEY`, `UNIPILE_ACCOUNT_ID`. Nothing else changes.

> Honest caveat: like the Playwright selectors, Unipile's exact API field shapes
> (provider ids, invite/chat endpoints) must be confirmed against your account
> before trusting it — the client is written defensively but unverified live.

## Email fallback channel (Instantly)

LinkedIn is the focus; **email is the fallback**. Enable it with
`EMAIL_CHANNEL=instantly` (+ `INSTANTLY_API_KEY`, `INSTANTLY_CAMPAIGN_ID`). Then:

- When a LinkedIn invite is **withdrawn as stale** and the lead has an `email`,
  the lead is enrolled into your Instantly campaign (`EMAIL_HANDOFF_ON_WITHDRAW`).
- An **email reply** pulls the lead out of the machine (→ `replied`).
- A **LinkedIn reply** pauses the lead's email sequence, so you never double-touch.

Same swappable pattern as the access layer: `EmailClient` interface +
`InstantlyClient` / `MockEmailClient` (`EMAIL_CHANNEL=mock` for dry-runs).

## Limitations / honesty

- **Cannot be fully tested without a live LinkedIn account + proxy.** The logic is
  covered by tests with a mock driver; the real browser flow (selectors, login)
  must be validated on your server.
- **LinkedIn changes its DOM** — `PlaywrightClient` selectors will occasionally
  need maintenance.
- Use responsibly, within LinkedIn's limits, for your own outreach only.
