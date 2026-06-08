// Generates lead magnets and LinkedIn posts.
//
// Two modes (gated on PERSONALIZER, same as the DM personalizer):
//   template   -> deterministic local templates. No AI, no network (tests/fallback).
//   claude-cli -> Claude via your Max plan generates the rich parts (magnet body,
//                 post copy). Short formulaic parts (name, CTA) stay deterministic.
//
// Posts carry a `hook` label and a `trigger_word`; the learning loop later picks
// the hooks that convert best.

import { runClaude, sanitize } from '../ai/claude.js';

export const POST_HOOKS = ['contrarian', 'story', 'listicle', 'question'];

const titleCase = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
const clamp = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// ---- Deterministic templates -------------------------------------------------

export function templateMagnet(topic, cfg) {
  const t = topic || (cfg.inbound.topics[0] || 'B2B outbound');
  const icp = cfg.inbound.icp || 'B2B founders';
  const trigger = cfg.inbound.triggerWord;
  return {
    name: `The ${titleCase(t)} Playbook`,
    description: `A practical ${t} checklist for ${icp}.`,
    cta: `Comment "${trigger}" and I'll send it over.`,
    body:
      `# The ${titleCase(t)} Playbook\n\n` +
      `A no-fluff checklist for ${icp}.\n\n` +
      `1. Define your ICP in one sentence.\n` +
      `2. Pick the single channel where they actually pay attention.\n` +
      `3. Lead with relevance, not a pitch.\n` +
      `4. Make one clear ask.\n` +
      `5. Follow up twice, then stop.\n` +
      `6. Measure replies, not sends.\n`,
  };
}

export function templatePost(magnet, hook, cfg) {
  const trigger = cfg.inbound.triggerWord;
  const icp = cfg.inbound.icp || 'people in your space';
  const openers = {
    contrarian: `Most ${icp} get this backwards.`,
    story: `A year ago I was doing this the hard way.`,
    listicle: `5 things I wish I knew earlier:`,
    question: `What's the one thing that actually moves the needle?`,
  };
  const opener = openers[hook] || openers.listicle;
  return {
    body:
      `${opener}\n\n` +
      `I put the essentials into "${magnet.name}" — ${magnet.description}\n\n` +
      `${magnet.cta}`,
    hook,
    trigger_word: trigger,
  };
}

// ---- Claude prompts ----------------------------------------------------------

// Shared voice/context block so generated content sounds like the operator and
// speaks to a specific audience — the difference between generic and good.
function voiceBlock(cfg) {
  const p = cfg.personalizer;
  const icp = cfg.inbound.icp || 'people in your space';
  const lines = [`AUDIENCE: ${icp}.`];
  if (p.senderName || p.senderRole) lines.push(`AUTHOR: ${p.senderName || 'the author'}${p.senderRole ? `, ${p.senderRole}` : ''}.`);
  if (p.valueProp) lines.push(`WHAT THEY DO: ${p.valueProp}`);
  lines.push(
    `VOICE: first person, specific, opinionated, earned-insight — like a practitioner ` +
      `sharing what actually worked, not a marketer. No buzzwords, no "in today's fast-paced ` +
      `world", no engagement-bait clichés.`
  );
  return lines.join('\n');
}

function magnetBodyPrompt(topic, cfg) {
  return (
    `${voiceBlock(cfg)}\n\n` +
    `Write a genuinely useful lead magnet (a practical checklist or short guide) on "${topic}" ` +
    `for the AUDIENCE above. It must be specific and immediately actionable — the kind of thing ` +
    `someone would screenshot. Markdown, ~150-300 words, skimmable, concrete examples over ` +
    `theory, no fluff, no self-promotion, no links. Output ONLY the markdown.`
  );
}

function postPrompt(magnet, hook, cfg) {
  const trigger = cfg.inbound.triggerWord;
  return (
    `${voiceBlock(cfg)}\n\n` +
    `Write a LinkedIn post that earns the right to promote a free resource. Use a "${hook}" ` +
    `opening hook tailored to the AUDIENCE. Structure: a strong first line that stops the ` +
    `scroll, then ONE real, specific insight with substance (a concrete example, number, or ` +
    `mistake), then naturally point to a free resource called "${magnet.name}" ` +
    `(${magnet.description}), and end by asking readers to comment "${trigger}" to get it.\n` +
    `Hard rules: under 1200 characters, short punchy lines with whitespace, sound human, give ` +
    `value BEFORE the ask, at most 1 emoji, no links, 0-2 relevant hashtags max, no ` +
    `engagement-bait. Output ONLY the post text.`
  );
}

export class ContentGenerator {
  constructor(config, logger = () => {}) {
    this.cfg = config;
    this.log = logger;
  }

  get _useClaude() {
    return this.cfg.personalizer.mode === 'claude-cli';
  }

  _claude(prompt) {
    return runClaude(prompt, { bin: this.cfg.personalizer.claudeBin, model: this.cfg.content.model });
  }

  async magnet(topic) {
    const base = templateMagnet(topic, this.cfg);
    if (!this._useClaude) return base;
    try {
      const body = sanitize(await this._claude(magnetBodyPrompt(topic || base.name, this.cfg)));
      return { ...base, body: body || base.body };
    } catch (err) {
      this.log(`[content] claude magnet failed, using template: ${err.message}`);
      return base;
    }
  }

  async post(magnet, hook = 'listicle') {
    const base = templatePost(magnet, hook, this.cfg);
    if (!this._useClaude) return base;
    try {
      const body = sanitize(await this._claude(postPrompt(magnet, hook, this.cfg)));
      return { ...base, body: clamp(body || base.body, 1200) };
    } catch (err) {
      this.log(`[content] claude post failed, using template: ${err.message}`);
      return base;
    }
  }
}
