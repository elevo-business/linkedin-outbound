// OpenAI image generation (gpt-image-1) — an alternative to Gemini. Renders the
// brief Claude wrote into a PNG on disk.
//
// IMPORTANT (honest caveat — validate against your account). Requires
// OPENAI_API_KEY. Default model: gpt-image-1.

import fs from 'node:fs';
import path from 'node:path';
import { ImageClient } from './ImageClient.js';

export class OpenAIImageClient extends ImageClient {
  constructor(config, logger = console.log) {
    super();
    this.cfg = config.image.openai;
    this.log = logger;
  }

  get enabled() {
    return Boolean(this.cfg.apiKey);
  }

  async generate(prompt, { outPath } = {}) {
    try {
      const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.cfg.model, prompt, n: 1, size: this.cfg.size }),
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, error: `OpenAI ${res.status}: ${text.slice(0, 200)}` };
      const json = JSON.parse(text);
      const b64 = json?.data?.[0]?.b64_json;
      if (!b64) return { ok: false, error: 'no image bytes in OpenAI response' };
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
      return { ok: true, path: outPath };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
}
