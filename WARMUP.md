# 30-Day Account Warmup (do this BEFORE any automation)

The single biggest thing that prevents a ban. The machine enforces it: it refuses
to send anything until `WARMUP_UNTIL` has passed. Set that to ~30 days from today.

## Why
LinkedIn restricts accounts that look new/bot-like or that suddenly spike in
behavior. Warmup makes the account look human and trusted, and makes the later
switch to automation a *gradual* change instead of a sudden spike.

## Before day 1 — make the profile look real (one-time)
- Real photo, clear headline, filled-out "About", at least 1–2 experience entries.
- A complete profile is itself a trust signal and lifts acceptance rate.
- Always log in from your **normal location/IP**. The residential proxy you use
  later for the automation should match **this same city** — a sudden location
  jump is a red flag.

## The ramp (all 100% MANUAL — no tooling)

| Week | Daily login | Engagement | Manual connects/day | Posts/week |
|------|-------------|------------|---------------------|------------|
| 1 | yes | like 3–5, comment 1–2 thoughtfully | 2–5 (people you know / clearly relevant) | 0–1 |
| 2 | yes | like 5–8, comment 2–3 | 5–10 | 1–2 |
| 3 | yes | keep commenting | 10–15 | 2–3 |
| 4 | yes | keep commenting | ~15 (the level the tool will run at) | 2–3 |

Key points:
- **Acceptance rate matters most.** Early on, connect with people who are very
  likely to accept (people you know, same industry, warm context). A high accept
  rate raises your trust; lots of ignored requests lowers it.
- **Be consistent**, not bursty: a little every day beats a big batch once.
- By week 4 you're already doing manually what the machine will do, so flipping it
  on is not a behavior spike.

## Then flip the machine on
1. On your server: `npm install playwright && npx playwright install chromium`
2. `node scripts/login.js` (manual login → saves the session)
3. In `.env`: `LINKEDIN_DRIVER=playwright`, `PERSONALIZER=claude-cli`,
   set the residential `PROXY_*` (your city), and `WARMUP_UNTIL=<today's date>`.
4. Keep the conservative caps. Let the ramp-up (5 → 15/day) do its job. Don't raise
   limits in the first weeks.
5. Watch `node scripts/status.js` daily. If LinkedIn shows any warning/restriction,
   stop immediately and slow down.

## Strongly recommended
Run the first 1–2 weeks of *automation* on a **secondary/burner account** before
pointing it at your main profile. If something is wrong with selectors, proxy, or
pacing, you find out without risking the account you care about.
