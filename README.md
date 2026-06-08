# LinkedIn Outbound Machine

A personal LinkedIn outbound tool: send connection requests → personalized DM →
timed follow-ups, with **conservative, ban-avoiding rate limits** and a
**swappable access layer**. Built for one operator on one account, for their own
outreach.

> Companion to an existing email outbound setup (e.g. Instantly). LinkedIn is the
> low-volume / high-trust channel; email is the volume channel. The long game is
> running both against the same lead.

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
      ├─ access layer:  Playwright (real) | Mock (dry-run) | Unipile (future)
      ├─ personalizer:  Claude via your Max plan (headless CLI) | local templates
      ├─ rate limiter:  daily/weekly/hourly caps + work hours + ramp-up
      └─ notifier:      console | Telegram  (pings you on replies)
```

Each **tick** does all safe bookkeeping (detect replies, detect accepted invites,
expire old sequences) plus **at most one outbound send**, to stay human-like. The
runner loops with randomized delays inside your configured work hours.

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
- **`PERSONALIZER`** — `template` (offline) or `claude-cli` (your Max plan).
- **`SENDER_NAME`, `SENDER_ROLE`, `VALUE_PROP`** — context fed to the personalizer.

## Lead CSV format

```csv
linkedin_url,name,headline,company,role,location,notes
https://www.linkedin.com/in/jane-doe,Jane Doe,Head of Sales,Acme,Head of Sales,Berlin,met at event
```

Only `linkedin_url` is required. Re-importing the same URL updates the lead.

## Project layout

```
src/
  config.js              env + .env loader
  db/{db,leads}.js       SQLite + lead repository / status machine
  linkedin/              access layer: LinkedInClient (interface), MockClient,
                         PlaywrightClient, index.js (factory)
  ai/personalizer.js     Claude-CLI + local templates
  core/{rateLimiter,sequencer}.js   limits + the brain
  notify/notifier.js     console / Telegram
  runner.js              entry point (--once or loop)
scripts/                 import-leads, status, login
test/                    node:test suite (run: npm test)
```

## Swapping to Unipile later

Add `src/linkedin/UnipileClient.js` implementing the same `LinkedInClient`
interface, register it in `src/linkedin/index.js`, set `LINKEDIN_DRIVER=unipile`.
Nothing else changes.

## Limitations / honesty

- **Cannot be fully tested without a live LinkedIn account + proxy.** The logic is
  covered by tests with a mock driver; the real browser flow (selectors, login)
  must be validated on your server.
- **LinkedIn changes its DOM** — `PlaywrightClient` selectors will occasionally
  need maintenance.
- Use responsibly, within LinkedIn's limits, for your own outreach only.
