// Go-live preflight: checks everything needed for the first inbound post to go
// out with a complete setup (publish -> capture -> deliver -> CRM). Pure-ish and
// injectable so it's testable; the script wraps it.
//
// Levels: 'ok' (good), 'warn' (works but degraded), 'block' (first post can't
// fully work until fixed).

import fs from 'node:fs';
import { RateLimiter } from './core/rateLimiter.js';
import { breakerActive } from './core/breaker.js';

export async function preflightChecks(config, db, { claudeAvailable, pingCapture } = {}) {
  const now = new Date();
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail });

  const [maj, min] = process.versions.node.split('.').map(Number);
  add('Node >= 22.5', maj > 22 || (maj === 22 && min >= 5) ? 'ok' : 'block', `found ${process.versions.node}`);

  // --- LinkedIn driver + auth ---
  if (config.driver === 'mock') {
    add('LinkedIn driver', 'block', 'driver=mock is a dry-run — set LINKEDIN_DRIVER=unipile (recommended) or playwright');
  } else if (config.driver === 'unipile') {
    const ok = Boolean(config.unipile.dsn && config.unipile.apiKey && config.unipile.accountId);
    add('Unipile credentials', ok ? 'ok' : 'block', ok ? 'set' : 'missing UNIPILE_DSN / UNIPILE_API_KEY / UNIPILE_ACCOUNT_ID');
  } else if (config.driver === 'playwright') {
    const sess = fs.existsSync(config.playwright.sessionPath);
    add('Playwright session', sess ? 'ok' : 'block', sess ? config.playwright.sessionPath : 'run `node scripts/login.js`');
    add('Residential proxy', config.playwright.proxyServer ? 'ok' : 'warn', config.playwright.proxyServer ? 'set' : 'empty — required on a VPS to avoid bans');
    add('Inbound comment scan', 'warn', 'Playwright cannot capture the published post URN, so comment scanning is unreliable — Unipile is recommended for inbound');
  }

  // --- Safety gates ---
  add('Warmup passed', now >= new Date(config.warmupUntil) ? 'ok' : 'block', `WARMUP_UNTIL=${config.warmupUntil}`);
  const within = new RateLimiter(db, config).withinWorkHours(now);
  add('Within work hours now', within ? 'ok' : 'warn', within ? 'yes' : `outside ${config.work.hoursStart}:00–${config.work.hoursEnd}:00 — first post waits for the window`);
  add('Circuit breaker', breakerActive(db, config, now) ? 'block' : 'ok', breakerActive(db, config, now) ? 'ACTIVE — clear it (log in manually) before going live' : 'ok');

  // --- Content quality ---
  if (config.personalizer.mode === 'claude-cli') {
    const ca = claudeAvailable ?? true;
    add('Claude CLI', ca ? 'ok' : 'warn', ca ? `${config.personalizer.claudeBin} (model ${config.content.model})` : 'not found on PATH — content will fall back to templates');
  } else {
    add('Content model', 'warn', 'PERSONALIZER=template gives generic content — set PERSONALIZER=claude-cli for quality');
  }

  // --- Delivery + tracking ---
  const base = config.inbound.captureBaseUrl || '';
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(base) || !base;
  add('Capture base URL public', isLocal ? 'block' : 'ok', isLocal ? `${base || '(empty)'} is local — the magnet DM link won't work for leads; set a public CAPTURE_BASE_URL` : base);
  if (pingCapture) {
    const up = await pingCapture(base);
    add('Capture server reachable', up ? 'ok' : 'warn', up ? '/health responded' : 'no /health — start `npm run capture-server`');
  }

  // --- Content exists to publish ---
  const magnets = db.get(`SELECT COUNT(*) AS n FROM magnets`).n;
  add('A lead magnet exists', magnets ? 'ok' : 'block', magnets ? `${magnets}` : 'run `npm run gen-magnet -- "<topic>"`');
  const scheduled = db.get(`SELECT COUNT(*) AS n FROM posts WHERE status='scheduled'`).n;
  add('A post is scheduled', scheduled ? 'ok' : 'block', scheduled ? `${scheduled} scheduled` : 'run `npm run gen-posts -- <magnetId> 1 --now`');
  const due = db.get(`SELECT COUNT(*) AS n FROM posts WHERE status='scheduled' AND (scheduled_at IS NULL OR scheduled_at <= $now)`, { now: now.toISOString() }).n;
  add('A post is due now', due ? 'ok' : 'warn', due ? 'will publish on the next inbound tick' : 'next post is scheduled for later — add one with `--now` to publish immediately');

  // --- CRM hand-off ---
  if (config.crm.provider === 'pipedrive') {
    add('Pipedrive token', config.crm.pipedrive.apiToken ? 'ok' : 'block', config.crm.pipedrive.apiToken ? 'set' : 'missing PIPEDRIVE_API_TOKEN');
  } else {
    add('CRM hand-off', 'warn', `CRM_PROVIDER=${config.crm.provider} — captured leads won't reach a CRM (set pipedrive to enable)`);
  }

  return checks;
}

export function summarize(checks) {
  const blocks = checks.filter((c) => c.level === 'block').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  return { blocks, warns, ready: blocks === 0 };
}
