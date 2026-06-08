// Image-layer factory + a helper that briefs (Claude) then renders (image model)
// a post image and stores its path on the post.

import path from 'node:path';
import { NullImageClient } from './ImageClient.js';
import { MockImageClient } from './MockImageClient.js';

export async function createImageClient(config, logger = console.log) {
  switch (config.image.provider) {
    case 'none':
      return new NullImageClient();
    case 'mock':
      return new MockImageClient({ logger });
    case 'gemini': {
      const { GeminiImageClient } = await import('./GeminiImageClient.js');
      return new GeminiImageClient(config, logger);
    }
    case 'openai': {
      const { OpenAIImageClient } = await import('./OpenAIImageClient.js');
      return new OpenAIImageClient(config, logger);
    }
    default:
      throw new Error(`Unknown IMAGE_PROVIDER: ${config.image.provider}`);
  }
}

// Generate (brief -> render) and persist an image for a post. Returns
// { ok, path?, brief?, error? }. Caller stores the path via posts.setImage.
export async function generatePostImage({ image, contentGenerator, config, post, magnet, campaign }) {
  if (!image.enabled) return { ok: false, skipped: true };
  const brief = await contentGenerator.imageBrief(post, magnet, campaign);
  const outPath = path.join(config.image.dir, `post-${post.id}.png`);
  const res = await image.generate(brief, { outPath });
  return res.ok ? { ok: true, path: res.path, brief } : { ok: false, error: res.error, brief };
}
