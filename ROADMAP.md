# Roadmap — pivot to an inbound, LeadPanther-style engine

Direction (decided): **pivot toward inbound.** The cold-outbound machine stays in
the repo as a secondary motor; the new primary motor is content-driven inbound
lead capture, in the spirit of leadpanther.ai ("post once, capture forever").

AI engine: **Claude via the Max-plan CLI** for all generation (Opus for the few
quality-critical assets — magnets, posts; Sonnet for high-volume DMs). The
"continuously learning" part is a bandit/heuristic layer over real outcomes — no
separate ML engine.

Email: captured addresses are **exported to the user's existing Instantly setup**
(the user runs Instantly themselves; we only hand off the addresses).

Honesty rule (unchanged): logic is covered by tests with mock drivers; the real
LinkedIn read/write flows (publishing, reading comments, accepting invites) and
selectors/API shapes must be validated live on the server.

---

## Phase 1 — Content foundation
- [x] DB: `magnets`, `posts`, `engagements` tables (+ idempotent migration).
- [x] Repos: Magnets, Posts, Engagements.
- [x] ContentGenerator (Claude-CLI + template fallback): generate lead magnets and posts.
- [x] Config: `inbound` section (ICP, topics, trigger keyword, cadence, delivery mode).
- [x] Scripts: `gen-magnet.js`, `gen-posts.js`.
- [x] Tests (template mode, no network).

## Phase 2 — Inbound capture brain
- [x] Extend the LinkedIn driver interface: `publishPost`, `getPostComments`,
      `getPendingInvites`, `acceptInvite`. Full MockClient impl; Playwright/Unipile
      defensive impl.
- [x] InboundSequencer: publish due posts → scan comments for the trigger →
      create engagements → auto-accept pending invites → DM the magnet → detect
      reply. Throttled, rate-limited, circuit-breaker aware.
- [x] Inbound runner (`src/inboundRunner.js`).
- [x] Tests.

## Phase 3 — Capture, delivery, hand-off, learning
- [x] Minimal gated capture web server (built-in http): `/m/:slug` landing page,
      email form, click + capture tracking.
- [x] Automatic document delivery: the magnet link is sent right in the LinkedIn
      chat (DM); clicks/captures are tracked back to the engagement.
- [x] **Pipedrive CRM hand-off**: swappable CRM layer; a captured / taken-over
      lead is created in Pipedrive via API token (person + lead + note), trigger
      via `CRM_CREATE_ON`.
- [x] Learning loop: per-hook outcome stats + epsilon-greedy bandit (`pickHook`),
      `gen-posts --learn`.
- [x] `status.js` inbound section + analytics.
- [x] Tests.

## Phase 4 — Docs & polish
- [x] README inbound section; scripts wired into package.json.
- [x] End-to-end mock dry-run verified.

## Phase 5 — Dynamic campaigns (no single global ICP)
- [x] `campaigns` table + repo; magnets/posts gain `campaign_id` (migration).
- [x] ContentGenerator takes a per-campaign context (ICP/topics/trigger/voice);
      env INBOUND_* become fallback defaults only.
- [x] Sequencer scans each post with ITS trigger word; delivery mode per magnet.
- [x] `scripts/campaign.js` (add/list/pause/activate); gen-magnet `--campaign`,
      gen-posts inherits the campaign from its magnet.
- [x] status.js campaigns section; tests (58 green).

## Still manual / live-only (by design — you do these)
- Pick the driver and fill keys (Playwright login+proxy, or Unipile DSN/key/account).
- Validate live: post publishing, comment reading, invite accepting, and the
  Unipile/Pipedrive API field shapes (defensive but unverified, like the Playwright
  selectors).
- Put the capture server behind a public URL and set `CAPTURE_BASE_URL`.

## Possible next steps (not built)
- Auto-scheduling: have the inbound loop generate + schedule new posts on a cadence.
- Feed winning hooks/copy back into the generation prompts (closing the learn loop
  fully, beyond hook selection).
- DM-based magnet requests (capture people who DM, not just commenters).
