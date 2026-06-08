// In-memory image client: writes a tiny placeholder PNG. For tests and
// IMAGE_PROVIDER=mock dry-runs.

import fs from 'node:fs';
import path from 'node:path';
import { ImageClient } from './ImageClient.js';

// 1x1 transparent PNG.
const PLACEHOLDER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

export class MockImageClient extends ImageClient {
  constructor(opts = {}) {
    super();
    this.failGenerate = opts.failGenerate ?? false;
    this.logger = opts.logger ?? (() => {});
    this.actions = [];
  }

  get enabled() {
    return true;
  }

  async generate(prompt, { outPath } = {}) {
    this.actions.push({ type: 'generate', prompt, outPath });
    this.logger(`[image:mock] generate -> ${outPath}`);
    if (this.failGenerate) return { ok: false, error: 'mock: failGenerate' };
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, PLACEHOLDER);
    }
    return { ok: true, path: outPath };
  }
}
