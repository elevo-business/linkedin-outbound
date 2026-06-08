// Loads configuration from environment + an optional .env file.
// Deliberately dependency-free: a tiny .env parser keeps the project installable
// with zero `npm install` for the core/testable logic.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// Load .env once, unless tests opt out by setting LO_NO_DOTENV.
if (!process.env.LO_NO_DOTENV) {
  loadDotEnv(path.join(ROOT, '.env'));
}

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const str = (v, d) => (v === undefined || v === '' ? d : v);
const bool = (v, d) => (v === undefined || v === '' ? d : v === 'true' || v === '1');
const list = (v, d) =>
  v === undefined || v === '' ? d : v.split(',').map((x) => x.trim()).filter(Boolean);

export function loadConfig(overrides = {}) {
  const cfg = {
    root: ROOT,
    driver: str(process.env.LINKEDIN_DRIVER, 'mock'),
    dbPath: path.resolve(ROOT, str(process.env.DB_PATH, './data/outbound.db')),

    warmupUntil: str(process.env.WARMUP_UNTIL, '2099-01-01'),

    limits: {
      invitesPerDay: num(process.env.MAX_INVITES_PER_DAY, 15),
      invitesPerWeek: num(process.env.MAX_INVITES_PER_WEEK, 90),
      invitesPerHour: num(process.env.MAX_INVITES_PER_HOUR, 6),
      messagesPerDay: num(process.env.MAX_MESSAGES_PER_DAY, 40),
      rampUpDays: num(process.env.RAMP_UP_DAYS, 7),
      rampUpStartInvites: num(process.env.RAMP_UP_START_INVITES, 5),
    },

    work: {
      hoursStart: num(process.env.WORK_HOURS_START, 9),
      hoursEnd: num(process.env.WORK_HOURS_END, 17),
      days: list(process.env.WORK_DAYS, ['1', '2', '3', '4', '5']).map(Number),
      timezone: str(process.env.TIMEZONE, 'Europe/Berlin'),
    },

    delays: {
      minSeconds: num(process.env.MIN_DELAY_SECONDS, 90),
      maxSeconds: num(process.env.MAX_DELAY_SECONDS, 420),
    },

    sequence: {
      daysBeforeFirstDm: num(process.env.DAYS_BEFORE_FIRST_DM, 1),
      daysBeforeFollowup1: num(process.env.DAYS_BEFORE_FOLLOWUP_1, 3),
      daysBeforeFollowup2: num(process.env.DAYS_BEFORE_FOLLOWUP_2, 4),
      daysBeforeDone: num(process.env.DAYS_BEFORE_DONE, 5),
    },

    // Throttle expensive per-lead checks (reply/acceptance detection): re-check a
    // given lead at most every `intervalHours`, and at most `maxPerTick` leads/tick.
    checks: {
      intervalHours: num(process.env.CHECK_INTERVAL_HOURS, 6),
      maxPerTick: num(process.env.MAX_CHECKS_PER_TICK, 5),
    },

    invites: {
      // Attach a personalized note to connection requests. LinkedIn caps NOTED
      // invites hard (free accounts ~5/month); once the monthly budget is spent
      // we keep inviting WITHOUT a note rather than failing.
      attachNote: bool(process.env.ATTACH_NOTE, true),
      maxNotedPerMonth: num(process.env.MAX_NOTED_INVITES_PER_MONTH, 5), // 0 = unlimited
      // Pull back invites that have been pending this long (too many open invites
      // is itself a ban signal). Bounded per tick so it stays human-like.
      withdrawAfterDays: num(process.env.WITHDRAW_INVITE_AFTER_DAYS, 21),
      maxWithdrawalsPerTick: num(process.env.MAX_WITHDRAWALS_PER_TICK, 2),
    },

    safety: {
      // After a checkpoint/auth-wall is detected, stay fully dark for this long.
      breakerCooldownHours: num(process.env.SAFETY_BREAKER_COOLDOWN_HOURS, 12),
    },

    // Inbound (content-driven) engine: post -> comment -> magnet delivery -> capture.
    inbound: {
      icp: str(process.env.INBOUND_ICP, ''), // who the content targets
      topics: list(process.env.INBOUND_TOPICS, []), // content themes
      triggerWord: str(process.env.INBOUND_TRIGGER_WORD, 'guide'), // comment keyword
      deliveryMode: str(process.env.MAGNET_DELIVERY, 'dm'), // dm | gated
      captureBaseUrl: str(process.env.CAPTURE_BASE_URL, 'http://localhost:3000'),
      autoAccept: bool(process.env.INBOUND_AUTO_ACCEPT, true),
      scanIntervalHours: num(process.env.INBOUND_SCAN_INTERVAL_HOURS, 4),
      // Per-tick budgets (kept low to stay human-like, like the outbound machine).
      maxPostsPerTick: num(process.env.MAX_POSTS_PER_TICK, 1),
      maxScansPerTick: num(process.env.MAX_SCANS_PER_TICK, 3),
      maxDmsPerTick: num(process.env.MAX_INBOUND_DMS_PER_TICK, 1),
    },

    // Content generation models (Claude via the same Max-plan CLI). Quality-critical
    // assets default to a stronger model; everything still falls back to templates.
    content: {
      model: str(process.env.CONTENT_MODEL, 'claude-opus-4-8'),
    },

    server: {
      capturePort: num(process.env.CAPTURE_PORT, 3000),
    },

    // CRM hand-off for captured / taken-over inbound leads.
    crm: {
      provider: str(process.env.CRM_PROVIDER, 'none'), // none | pipedrive | mock
      createOn: str(process.env.CRM_CREATE_ON, 'both'), // capture | reply | both
      pipedrive: {
        baseUrl: str(process.env.PIPEDRIVE_BASE_URL, 'https://api.pipedrive.com/v1'),
        apiToken: str(process.env.PIPEDRIVE_API_TOKEN, ''),
        ownerId: str(process.env.PIPEDRIVE_OWNER_ID, ''),
      },
    },

    personalizer: {
      mode: str(process.env.PERSONALIZER, 'template'),
      claudeBin: str(process.env.CLAUDE_BIN, 'claude'),
      claudeModel: str(process.env.CLAUDE_MODEL, 'claude-sonnet-4-6'),
      senderName: str(process.env.SENDER_NAME, 'Your Name'),
      senderRole: str(process.env.SENDER_ROLE, 'Founder'),
      valueProp: str(process.env.VALUE_PROP, ''),
    },

    playwright: {
      sessionPath: path.resolve(ROOT, str(process.env.LINKEDIN_SESSION_PATH, './data/li-session.json')),
      proxyServer: str(process.env.PROXY_SERVER, ''),
      proxyUsername: str(process.env.PROXY_USERNAME, ''),
      proxyPassword: str(process.env.PROXY_PASSWORD, ''),
      headless: bool(process.env.HEADLESS, true),
    },

    // Unipile access layer (paid, more stable than Playwright). Same interface.
    unipile: {
      dsn: str(process.env.UNIPILE_DSN, ''), // e.g. https://apiXXX.unipile.com:13XXX
      apiKey: str(process.env.UNIPILE_API_KEY, ''),
      accountId: str(process.env.UNIPILE_ACCOUNT_ID, ''), // the connected LinkedIn account
    },

    // Optional second channel: email via Instantly. `none` disables it entirely.
    email: {
      channel: str(process.env.EMAIL_CHANNEL, 'none'), // none | instantly | mock
      // Hand a lead to email once its LinkedIn invite is withdrawn as stale and
      // the lead has an email address. Email is the fallback channel.
      handoffOnWithdraw: bool(process.env.EMAIL_HANDOFF_ON_WITHDRAW, true),
      instantly: {
        baseUrl: str(process.env.INSTANTLY_BASE_URL, 'https://api.instantly.ai/api/v2'),
        apiKey: str(process.env.INSTANTLY_API_KEY, ''),
        campaignId: str(process.env.INSTANTLY_CAMPAIGN_ID, ''),
      },
    },

    notify: {
      driver: str(process.env.NOTIFY_DRIVER, 'console'),
      telegramToken: str(process.env.TELEGRAM_BOT_TOKEN, ''),
      telegramChatId: str(process.env.TELEGRAM_CHAT_ID, ''),
    },
  };

  return deepMerge(cfg, overrides);
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
