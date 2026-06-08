// Abstract access layer. Every driver (mock, playwright, later unipile)
// implements this same surface, so the sequencer never depends on a specific one.
//
// All methods return plain results; they should NOT throw for ordinary
// "not yet"/"not found" cases — only for hard, unexpected failures.

export class LinkedInClient {
  /** Establish/restore a session. Returns { ok } */
  async login() {
    throw new Error('not implemented');
  }

  /** Send a connection request with a note. Returns { ok, error? } */
  async sendConnectionRequest(_lead, _note) {
    throw new Error('not implemented');
  }

  /** Has the invite been accepted? Returns boolean. */
  async isConnected(_lead) {
    throw new Error('not implemented');
  }

  /** Send a direct message. Returns { ok, error? } */
  async sendMessage(_lead, _text) {
    throw new Error('not implemented');
  }

  /** Did the lead reply since our last outbound message? Returns boolean. */
  async hasReply(_lead) {
    throw new Error('not implemented');
  }

  /** Withdraw a still-pending connection request. Returns { ok, error? } */
  async withdrawInvite(_lead) {
    throw new Error('not implemented');
  }

  // ---- inbound (content-driven) surface --------------------------------------

  /**
   * Publish a post. `opts.imagePath` (optional) attaches a generated image.
   * Returns { ok, ref?, error? } (ref = the post URN/URL).
   */
  async publishPost(_text, _opts) {
    throw new Error('not implemented');
  }

  /**
   * Read comments on a published post. `post` is the stored post row (has
   * external_ref). Returns an array of
   *   { name, profileUrl, profileRef, text, commentId }
   */
  async getPostComments(_post) {
    throw new Error('not implemented');
  }

  /** Pending incoming connection requests: [{ name, profileRef, invitationId }] */
  async getPendingInvites() {
    throw new Error('not implemented');
  }

  /** Accept an incoming connection request. Returns { ok, error? } */
  async acceptInvite(_invite) {
    throw new Error('not implemented');
  }

  /**
   * True once the driver has seen a hard block (checkpoint / auth wall / account
   * restriction). The sequencer uses this to trip a circuit breaker and stop
   * sending. Synchronous so it can be polled cheaply between actions.
   */
  isBlocked() {
    return false;
  }

  async close() {}
}
