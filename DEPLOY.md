# Deploy to Coolify (runbook for an operator/agent)

This deploys the LinkedIn Lead Machine as **three services from one repo** via
Docker Compose: `admin` (dashboard, :3001), `capture` (public landing pages,
:3000), and `inbound` (the content loop). They share one SQLite volume (`data`).

> Secrets are NOT in this file. The operator provides the env values (see the
> "Environment variables" table) out-of-band.

## 1. Create the resource in Coolify
1. **Projects → New → Resource → Docker Compose** (or "Public/Private Git via
   GitHub App").
2. Source: the connected GitHub App → repo **`elevo-business/linkedin-outbound`**.
3. Branch: **`claude/funny-faraday-2Lrmm`** (or `main` once merged).
4. Compose file path: **`docker-compose.yml`** (repo root). Build pack: **Docker Compose**.

## 2. Set environment variables
Paste the env block (KEY=VALUE lines) into Coolify's **Environment Variables**
(bulk edit). Required keys:

| Key | Notes |
|-----|-------|
| `LINKEDIN_DRIVER=unipile` | container uses Unipile (no browser/Playwright) |
| `UNIPILE_DSN` | e.g. `https://api34.unipile.com:16483` |
| `UNIPILE_API_KEY` | secret |
| `UNIPILE_ACCOUNT_ID` | the connected LinkedIn account id |
| `CRM_PROVIDER=pipedrive`, `CRM_CREATE_ON=both` | |
| `PIPEDRIVE_API_TOKEN` | secret |
| `ADMIN_PASSWORD` | strong password for the dashboard login |
| `ADMIN_PORT=3001`, `CAPTURE_PORT=3000` | |
| `CAPTURE_BASE_URL` | the PUBLIC URL Coolify assigns to the `capture` service (set after step 3) |
| `WARMUP_UNTIL` | a PAST date only if the 30-day account warmup is done; otherwise leave the future default to keep sending blocked |
| `CONTENT_ENGINE=claude-cli` | content via the Max plan headless (the `claude` CLI is in the image). Or `claude-api` (pay-per-token) / `template` (placeholder — do NOT use for real posts) |
| `CLAUDE_CODE_OAUTH_TOKEN` | **required for `claude-cli` in the container.** Run `claude setup-token` locally once (Max/Pro plan) → paste the 1-year token. No API key, no per-token cost |
| `CONTENT_MODEL=claude-opus-4-8`, `CONTENT_LANGUAGE=German` | model + content language (campaigns override language) |
| `IMAGE_PROVIDER=gemini`, `GEMINI_API_KEY` | per-post images (Claude writes the brief, Imagen renders). `none` to disable |
| `INBOUND_ICP`, `INBOUND_TOPICS`, `INBOUND_TRIGGER_WORD` | fallback defaults; real ICPs are created as campaigns in the dashboard |
| `NOTIFY_DRIVER`, `TELEGRAM_*` | optional reply pings |

## 3. Domains
1. Assign a public domain to the **`capture`** service (Coolify → service →
   Domains). HTTPS on.
2. Set `CAPTURE_BASE_URL` to exactly that domain, then **redeploy** (the magnet
   DM link must point at this public URL).
3. Assign a domain to the **`admin`** service too (HTTPS). Keep it private/behind
   the login.

## 4. Deploy
Click **Deploy**. The `data` volume persists the SQLite DB across deploys. SQLite
runs in WAL mode so the three services share the file safely.

## 5. Verify (post-deploy)
1. Open the **admin** domain → log in with `ADMIN_PASSWORD`.
2. Open **Preflight** in the dashboard — fix any ❌ (driver creds, warmup,
   capture URL, a magnet, a scheduled post).
3. **Campaigns → New**: create a campaign (ICP, topics, trigger word, delivery).
4. **Posts → Generate magnet** (pick the campaign), then **Generate posts**
   (mode: *publish now* for the first one).
5. Click **Run inbound tick** → the first post publishes. Then the `inbound`
   service keeps the loop running automatically.

## Notes / caveats
- **Unipile/Pipedrive API field shapes** are wired defensively but unverified
  live — run `node scripts/probe-unipile.js <handle>` once in the `inbound`
  container (or any host where the DSN port is reachable) and confirm.
- **Claude Max content in the container**: the `claude` CLI is baked into the
  image; set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, run once
  locally on a Max/Pro plan) so `CONTENT_ENGINE=claude-cli` works headless — no
  API key, no per-token cost. (Note: from 2026-06-15, headless `claude -p` draws
  from a separate monthly Agent-SDK quota.) Alternatively `CONTENT_ENGINE=claude-api`
  + `ANTHROPIC_API_KEY` (pay-per-token). Never ship real posts on `template`.
- **Rotate** the Unipile + Pipedrive credentials after go-live if they were shared
  in plaintext anywhere.
- Start on a secondary LinkedIn account for the first 1–2 weeks.
