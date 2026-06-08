// In-memory driver: performs NO real LinkedIn actions. Used for tests and for a
// safe dry-run (LINKEDIN_DRIVER=mock). Behaviour is fully injectable so tests
// can deterministically simulate acceptances and replies.

import { LinkedInClient } from './LinkedInClient.js';

export class MockClient extends LinkedInClient {
  /**
   * @param {object} opts
   * @param {(lead)=>boolean} [opts.acceptInvite]  whether an invited lead is "connected"
   * @param {(lead)=>boolean} [opts.reply]         whether a messaged lead has replied
   * @param {boolean} [opts.failConnect]           force connection requests to fail
   * @param {boolean} [opts.failWithdraw]          force invite withdrawals to fail
   * @param {boolean} [opts.blocked]               simulate a checkpoint/ban (isBlocked)
   * @param {(msg:string)=>void} [opts.logger]
   */
  constructor(opts = {}) {
    super();
    this.acceptInvite = opts.acceptInvite ?? (() => false);
    this.reply = opts.reply ?? (() => false);
    this.failConnect = opts.failConnect ?? false;
    this.failWithdraw = opts.failWithdraw ?? false;
    this.blocked = opts.blocked ?? false;
    this.logger = opts.logger ?? (() => {});
    this.actions = []; // recorded calls, useful for assertions
  }

  async login() {
    this.logger('[mock] login');
    return { ok: true };
  }

  async sendConnectionRequest(lead, note) {
    this.actions.push({ type: 'invite', url: lead.linkedin_url, note });
    this.logger(`[mock] invite -> ${lead.name || lead.linkedin_url}: "${note}"`);
    if (this.failConnect) return { ok: false, error: 'mock: failConnect' };
    return { ok: true };
  }

  async isConnected(lead) {
    return Boolean(this.acceptInvite(lead));
  }

  async sendMessage(lead, text) {
    this.actions.push({ type: 'message', url: lead.linkedin_url, text });
    this.logger(`[mock] message -> ${lead.name || lead.linkedin_url}: "${text}"`);
    return { ok: true };
  }

  async hasReply(lead) {
    return Boolean(this.reply(lead));
  }

  async withdrawInvite(lead) {
    this.actions.push({ type: 'withdraw', url: lead.linkedin_url });
    this.logger(`[mock] withdraw -> ${lead.name || lead.linkedin_url}`);
    if (this.failWithdraw) return { ok: false, error: 'mock: failWithdraw' };
    return { ok: true };
  }

  isBlocked() {
    return Boolean(this.blocked);
  }
}
