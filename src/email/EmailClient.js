// Abstract email (second channel) access layer. Mirrors LinkedInClient: every
// driver (null, mock, instantly) implements this same surface so the sequencer
// never depends on a specific email provider.
//
// Methods return plain results; they should NOT throw for ordinary "not yet" /
// "not found" cases — only for hard, unexpected failures.

export class EmailClient {
  /** Is this channel actually wired up (vs. the no-op null channel)? */
  get enabled() {
    return false;
  }

  /** Enroll a lead into the email campaign. Returns { ok, error? } */
  async enroll(_lead) {
    throw new Error('not implemented');
  }

  /** Has the lead replied by email since enrollment? Returns boolean. */
  async hasReply(_lead) {
    throw new Error('not implemented');
  }

  /** Pause/stop the lead's email sequence (e.g. they replied elsewhere). Returns { ok }. */
  async pause(_lead) {
    throw new Error('not implemented');
  }

  async close() {}
}

// The default when EMAIL_CHANNEL=none: does nothing, enables nothing.
export class NullEmailClient extends EmailClient {
  get enabled() {
    return false;
  }
  async enroll() {
    return { ok: false, skipped: true };
  }
  async hasReply() {
    return false;
  }
  async pause() {
    return { ok: true };
  }
}
