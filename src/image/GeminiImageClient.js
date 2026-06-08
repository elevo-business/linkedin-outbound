// Google image generation (Imagen via the Generative Language API). Renders the
// brief Claude wrote into a PNG on disk.
//
// IMPORTANT (honest caveat — validate against your account): the endpoint/field
// names below follow Imagen's `:predict` shape; confirm them for your key/model.
// Requires GEMINI_API_KEY. Default model: imagen-3.0-generate-002.

import fs from 'node:fs';
import path from 'node:path';
import { ImageClient } from './ImageClient.js';

export class GeminiImageClient extends ImageClient {
  constructor(config, logger = console.log) {
    super();
    this.cfg = config.image.gemini;
    this.log = logger;
  }

  get enabled() {
    return Boolean(this.cfg.apiKey);
  }

  async generate(prompt, { outPath, aspectRatio = '1:1' } = {}) {
    try {
      const base = `https://generativelanguage.googleapis.com/v1beta/models/${this.cfg.model}`;
      const key = encodeURIComponent(this.cfg.apiKey);
      let b64;
      if (/^imagen/i.test(this.cfg.model)) {
        // Imagen models use the :predict endpoint (paid tier).
        const res = await fetch(`${base}:predict?key=${key}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio } }),
          signal: AbortSignal.timeout(60000),
        });
        const text = await res.text();
        if (!res.ok) return { ok: false, error: `Gemini ${res.status}: ${text.slice(0, 200)}` };
        const json = JSON.parse(text);
        b64 = json?.predictions?.[0]?.bytesBase64Encoded || json?.predictions?.[0]?.image?.imageBytes;
      } else {
        // gemini-*-image models (e.g. the free gemini-2.5-flash-image) use
        // :generateContent and return the image inline.
        const res = await fetch(`${base}:generateContent?key=${key}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['IMAGE'] },
          }),
          signal: AbortSignal.timeout(60000),
        });
        const text = await res.text();
        if (!res.ok) return { ok: false, error: `Gemini ${res.status}: ${text.slice(0, 200)}` };
        const json = JSON.parse(text);
        const parts = json?.candidates?.[0]?.content?.parts || [];
        b64 = parts.find((p) => p?.inlineData?.data)?.inlineData?.data;
      }
      if (!b64) return { ok: false, error: 'no image bytes in Gemini response' };
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
      return { ok: true, path: outPath };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
}
