// Abstract image-generation layer. Claude writes the brief; an image MODEL
// renders the pixels (Claude is text-only and cannot generate images). Swappable
// like the access/email/CRM layers.

export class ImageClient {
  get enabled() {
    return false;
  }

  /** Render an image for `prompt` to `outPath`. Returns { ok, path?, error? }. */
  async generate(_prompt, _opts) {
    throw new Error('not implemented');
  }
}

// Default when IMAGE_PROVIDER=none.
export class NullImageClient extends ImageClient {
  get enabled() {
    return false;
  }
  async generate() {
    return { ok: false, skipped: true };
  }
}
