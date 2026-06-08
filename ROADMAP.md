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
- [ ] Extend the LinkedIn driver interface: `publishPost`, `getPostComments`,
      `getPendingInvites`, `acceptInvite`. Full MockClient impl; Playwright/Unipile
      defensive impl.
- [ ] InboundSequencer: publish due posts → scan comments for the trigger →
      create engagements → auto-accept pending invites → DM the magnet → detect
      email/reply. Throttled, rate-limited, circuit-breaker aware.
- [ ] Inbound runner / mode.
- [ ] Tests.

## Phase 3 — Capture, delivery, hand-off, learning
- [ ] Minimal gated capture web server (built-in http): `/m/:slug` landing page,
      email form, click + capture tracking (delivery + tracking must be solid).
- [ ] Automatic document delivery: the magnet link is sent right in the LinkedIn
      chat (DM) on engagement; clicks/captures are tracked back to the engagement.
- [ ] **Pipedrive CRM hand-off** (primary): a swappable CRM layer; a captured /
      taken-over lead is created in Pipedrive via API token (person + lead/deal),
      configurable trigger. (Instantly stays the user's own separate email setup.)
- [ ] Learning loop: track per-variant outcomes (post hook, CTA, DM), pick winners
      with a simple multi-armed bandit, feed winners back into the prompts.
- [ ] `status.js` inbound section + analytics.
- [ ] Tests.

## Phase 4 — Docs & polish
- [ ] README inbound section; wire scripts into package.json.
- [ ] End-to-end mock dry-run documented.
