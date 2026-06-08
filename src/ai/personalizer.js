// Generates the connection note and the DM/follow-up text.
//
// Two modes:
//   template   -> deterministic local templates. No AI, no network. Used in tests
//                 and as a safe fallback.
//   claude-cli -> shells out to the `claude` CLI (your Claude Max plan, headless),
//                 asking for a short, human, non-spammy message. Falls back to
//                 template on any error.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexecFile = promisify(execFile);

const firstName = (name) => (name ? name.trim().split(/\s+/)[0] : 'there');
const clamp = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// Strip artifacts an LLM sometimes adds despite "output only the message":
// code fences, a leading "Sure, here's…:" preamble line, and wrapping quotes.
// Keeps the raw text otherwise.
export function sanitize(text) {
  if (!text) return text;
  let s = text.trim();
  s = s.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  s = s.replace(/^(sure[,!]?|here(?:['’]s| is)|certainly[,!]?|of course[,!]?)[^\n]*:\s*\n+/i, '').trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith('“') && s.endsWith('”')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

// ---- Deterministic templates -------------------------------------------------

export function templateNote(lead, cfg) {
  const fn = firstName(lead.name);
  const ctx = lead.company ? ` what you're building at ${lead.company}` : ' your work';
  return clamp(`Hi ${fn}, came across your profile and liked${ctx}. Would be glad to connect.`, 300);
}

export function templateMessage(lead, cfg, step = 1) {
  const fn = firstName(lead.name);
  const vp = cfg.personalizer.valueProp || 'sharing notes with people in the space';
  if (step === 1) {
    return clamp(
      `Thanks for connecting, ${fn}! Quick reason I reached out: ${vp} ` +
        `Curious whether that's relevant for you right now — no pressure either way.`,
      900
    );
  }
  if (step === 2) {
    return clamp(`Following up, ${fn} — happy to share a concrete example if useful. Worth a quick chat?`, 900);
  }
  return clamp(`Last note from me, ${fn} — if the timing's off no worries, I'll leave it here. Always open if things change.`, 900);
}

// ---- Claude CLI (uses Max plan) ---------------------------------------------

function buildPrompt(kind, lead, cfg, step) {
  const profile = JSON.stringify(
    {
      name: lead.name,
      headline: lead.headline,
      company: lead.company,
      role: lead.role,
      location: lead.location,
    },
    null,
    2
  );
  const sender = `${cfg.personalizer.senderName} (${cfg.personalizer.senderRole})`;
  const vp = cfg.personalizer.valueProp;

  const rules =
    kind === 'note'
      ? `Write a LinkedIn CONNECTION NOTE. Hard rules: max 280 characters, ` +
        `one specific reference to their profile, warm and human, NO pitch, NO links, ` +
        `no "I help you" sales language.`
      : `Write LinkedIn DIRECT MESSAGE #${step} (after they accepted). Hard rules: ` +
        `under 600 characters, conversational, lead with relevance/value not a hard sell, ` +
        `one light call to action at most, no links.`;

  return (
    `You write outbound messages for ${sender}. Offer/context: ${vp}\n` +
    `Recipient profile:\n${profile}\n\n${rules}\n` +
    `Output ONLY the message text, nothing else.`
  );
}

async function claudeGenerate(prompt, cfg) {
  const { stdout } = await pexecFile(
    cfg.personalizer.claudeBin,
    ['-p', prompt, '--model', cfg.personalizer.claudeModel],
    { timeout: 60000, maxBuffer: 1024 * 1024 }
  );
  return stdout.trim();
}

export class Personalizer {
  constructor(config, logger = () => {}) {
    this.cfg = config;
    this.log = logger;
  }

  async note(lead) {
    if (this.cfg.personalizer.mode !== 'claude-cli') return templateNote(lead, this.cfg);
    try {
      const out = sanitize(await claudeGenerate(buildPrompt('note', lead, this.cfg), this.cfg));
      return clamp(out || templateNote(lead, this.cfg), 300);
    } catch (err) {
      this.log(`[personalizer] claude note failed, using template: ${err.message}`);
      return templateNote(lead, this.cfg);
    }
  }

  async message(lead, step = 1) {
    if (this.cfg.personalizer.mode !== 'claude-cli') return templateMessage(lead, this.cfg, step);
    try {
      const out = sanitize(await claudeGenerate(buildPrompt('message', lead, this.cfg, step), this.cfg));
      return clamp(out || templateMessage(lead, this.cfg, step), 1200);
    } catch (err) {
      this.log(`[personalizer] claude message failed, using template: ${err.message}`);
      return templateMessage(lead, this.cfg, step);
    }
  }
}
