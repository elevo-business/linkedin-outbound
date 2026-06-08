// Generates lead magnets, LinkedIn posts, and image briefs.
//
// Engine (CONTENT_ENGINE):
//   template   -> deterministic offline placeholder. A SAFETY NET, not for real
//                 posts — it cannot write attention-grabbing copy.
//   claude-cli -> Claude Max plan via the `claude` CLI (interactive login).
//   claude-api -> Anthropic API (headless; recommended for deploys).
//
// Audience / voice / LANGUAGE come from the CAMPAIGN when one is passed (dynamic,
// many in parallel), else from the CONTENT_*/INBOUND_* env defaults.

import { runClaude, sanitize } from '../ai/claude.js';
import { runAnthropic } from '../ai/anthropic.js';

export const POST_HOOKS = ['contrarian', 'story', 'listicle', 'question'];

const titleCase = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
const clamp = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export function contentContext(cfg, campaign = null) {
  const p = cfg.personalizer;
  const inb = cfg.inbound;
  const topics = campaign?.topics
    ? campaign.topics.split(',').map((t) => t.trim()).filter(Boolean)
    : inb.topics;
  return {
    icp: campaign?.icp || inb.icp || 'people in your space',
    triggerWord: campaign?.trigger_word || inb.triggerWord,
    topics,
    language: campaign?.language || cfg.content.language || 'English',
    senderName: campaign?.sender_name || p.senderName,
    senderRole: campaign?.sender_role || p.senderRole,
    valueProp: campaign?.value_prop || p.valueProp,
  };
}

// ---- Deterministic templates (safety net only) ------------------------------

export function templateMagnet(topic, ctx) {
  const t = topic || ctx.topics[0] || 'B2B outbound';
  return {
    name: clamp(`The ${titleCase(t)} Playbook`, 70),
    description: `A practical ${t} checklist for ${ctx.icp}.`,
    cta: `Comment "${ctx.triggerWord}" and I'll send it over.`,
    body:
      `# ${clamp(`The ${titleCase(t)} Playbook`, 70)}\n\n` +
      `A no-fluff checklist for ${ctx.icp}.\n\n` +
      `1. Define the one outcome that matters.\n` +
      `2. Cut the steps that don't move it.\n` +
      `3. Automate the repetitive parts.\n` +
      `4. Make one clear ask.\n` +
      `5. Measure results, not activity.\n`,
  };
}

export function templatePost(magnet, hook, ctx) {
  // Openers are self-contained (no raw ICP/topic interpolation) so the fallback
  // never produces grammatically broken copy.
  const openers = {
    contrarian: `Here's something most people get backwards:`,
    story: `A year ago, I was doing this the hard way.`,
    listicle: `A few things I wish I'd known sooner:`,
    question: `What actually moves the needle here?`,
  };
  const opener = openers[hook] || openers.listicle;
  return {
    body: `${opener}\n\nI pulled the essentials into "${magnet.name}".\n\n${magnet.description}\n\n${magnet.cta}`,
    hook,
    trigger_word: ctx.triggerWord,
  };
}

export function templateImageBrief(magnet, ctx) {
  const subject = magnet?.name || ctx.topics[0] || 'business growth';
  return (
    `A clean, modern, professional editorial illustration for a LinkedIn post about ${subject}. ` +
    `Minimal, conceptual, soft lighting, tasteful color palette, no text or words, no logos, ` +
    `suitable for an audience of ${ctx.icp}.`
  );
}

// ---- LLM prompts -------------------------------------------------------------

function voiceBlock(ctx) {
  const lines = [`AUDIENCE: ${ctx.icp}.`, `LANGUAGE: write everything in ${ctx.language}.`];
  if (ctx.senderName || ctx.senderRole) {
    lines.push(`AUTHOR: ${ctx.senderName || 'the author'}${ctx.senderRole ? `, ${ctx.senderRole}` : ''}.`);
  }
  if (ctx.valueProp) lines.push(`WHAT THEY DO: ${ctx.valueProp}`);
  lines.push(
    `VOICE: first person, specific, opinionated, earned-insight — like a practitioner ` +
      `sharing what actually worked, not a marketer. No buzzwords, no "in today's fast-paced ` +
      `world", no engagement-bait clichés.`
  );
  return lines.join('\n');
}

function magnetBodyPrompt(topic, ctx) {
  return (
    `${voiceBlock(ctx)}\n\n` +
    `Write a genuinely useful lead magnet (a practical checklist or short guide) on "${topic}" ` +
    `for the AUDIENCE above, in their LANGUAGE. It must be specific and immediately actionable — ` +
    `the kind of thing someone screenshots. Markdown, ~150-300 words, skimmable, concrete examples ` +
    `over theory, no fluff, no self-promotion, no links. Output ONLY the markdown.`
  );
}

function postPrompt(magnet, hook, ctx) {
  return (
    `${voiceBlock(ctx)}\n\n` +
    `Write a LinkedIn post in the AUDIENCE's LANGUAGE that earns the right to promote a free ` +
    `resource. Use a "${hook}" opening hook tailored to the AUDIENCE. Structure: a strong first ` +
    `line that stops the scroll, then ONE real, specific insight with substance (a concrete ` +
    `example, number, or mistake), then naturally point to a free resource called "${magnet.name}" ` +
    `(${magnet.description}), and end by asking readers to comment "${ctx.triggerWord}" to get it.\n` +
    `Hard rules: under 1200 characters, short punchy lines with whitespace, sound human, give value ` +
    `BEFORE the ask, at most 1 emoji, no links, 0-2 relevant hashtags max, no engagement-bait. ` +
    `Output ONLY the post text.`
  );
}

function imagePromptPrompt(post, magnet, ctx) {
  const about = (post?.body || magnet?.description || ctx.topics[0] || '').slice(0, 400);
  return (
    `Write a single image-generation prompt for a professional LinkedIn post graphic.\n` +
    `The post is about: "${about}". Audience: ${ctx.icp}.\n` +
    `Style: clean, modern, on-brand, conceptual or editorial, tasteful palette, NO text or words ` +
    `in the image, no logos, no watermarks. Output ONLY the prompt, in English, under 60 words.`
  );
}

export class ContentGenerator {
  constructor(config, logger = () => {}) {
    this.cfg = config;
    this.log = logger;
  }

  get _engine() {
    return this.cfg.content.engine;
  }
  get _useLLM() {
    return this._engine === 'claude-api' || this._engine === 'claude-cli';
  }
  _llm(prompt, maxTokens = 1024) {
    if (this._engine === 'claude-api') {
      return runAnthropic(prompt, { apiKey: this.cfg.content.apiKey, model: this.cfg.content.model, maxTokens });
    }
    return runClaude(prompt, { bin: this.cfg.personalizer.claudeBin, model: this.cfg.content.model });
  }

  async magnet(topic, campaign = null) {
    const ctx = contentContext(this.cfg, campaign);
    const base = templateMagnet(topic, ctx);
    if (!this._useLLM) return base;
    try {
      const body = sanitize(await this._llm(magnetBodyPrompt(topic || base.name, ctx), 1500));
      return { ...base, body: body || base.body };
    } catch (err) {
      this.log(`[content] magnet failed (${this._engine}), using template: ${err.message}`);
      return base;
    }
  }

  async post(magnet, hook = 'listicle', campaign = null) {
    const ctx = contentContext(this.cfg, campaign);
    const base = templatePost(magnet, hook, ctx);
    if (!this._useLLM) return base;
    try {
      const body = sanitize(await this._llm(postPrompt(magnet, hook, ctx), 1024));
      return { ...base, body: clamp(body || base.body, 1200) };
    } catch (err) {
      this.log(`[content] post failed (${this._engine}), using template: ${err.message}`);
      return base;
    }
  }

  // A short English image-generation prompt describing a graphic for the post.
  async imageBrief(post, magnet, campaign = null) {
    const ctx = contentContext(this.cfg, campaign);
    if (!this._useLLM) return templateImageBrief(magnet, ctx);
    try {
      const brief = sanitize(await this._llm(imagePromptPrompt(post, magnet, ctx), 300));
      return brief || templateImageBrief(magnet, ctx);
    } catch (err) {
      this.log(`[content] image brief failed (${this._engine}), using template: ${err.message}`);
      return templateImageBrief(magnet, ctx);
    }
  }
}
