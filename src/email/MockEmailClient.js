// In-memory email channel: performs NO real actions. Used for tests and a safe
// dry-run (EMAIL_CHANNEL=mock). Behaviour is injectable so tests can simulate
// enrollments, replies, and pauses deterministically.

import { EmailClient } from './EmailClient.js';

export class MockEmailClient extends EmailClient {
  /**
   * @param {object} opts
   * @param {(lead)=>boolean} [opts.reply]       whether an enrolled lead has replied
   * @param {boolean} [opts.failEnroll]          force enrollments to fail
   * @param {(msg:string)=>void} [opts.logger]
   */
  constructor(opts = {}) {
    super();
    this.reply = opts.reply ?? (() => false);
    this.failEnroll = opts.failEnroll ?? false;
    this.logger = opts.logger ?? (() => {});
    this.actions = []; // recorded calls, useful for assertions
  }

  get enabled() {
    return true;
  }

  async enroll(lead) {
    this.actions.push({ type: 'enroll', url: lead.linkedin_url, email: lead.email });
    this.logger(`[email:mock] enroll -> ${lead.email || lead.linkedin_url}`);
    if (this.failEnroll) return { ok: false, error: 'mock: failEnroll' };
    return { ok: true };
  }

  async hasReply(lead) {
    return Boolean(this.reply(lead));
  }

  async pause(lead) {
    this.actions.push({ type: 'pause', url: lead.linkedin_url, email: lead.email });
    this.logger(`[email:mock] pause -> ${lead.email || lead.linkedin_url}`);
    return { ok: true };
  }
}
