// The brain. One `tick()` performs all safe bookkeeping (reply detection,
// acceptance checks, expiries) plus AT MOST ONE outbound "send" action, to stay
// human-like. A runner calls tick() repeatedly with jittered delays.
//
// Everything time-related goes through `clock()` so tests control the clock.

import { STATUS } from '../db/leads.js';

const DAY = 24 * 3600 * 1000;
const daysSince = (iso, now) => (iso ? (now.getTime() - new Date(iso).getTime()) / DAY : Infinity);

export class Sequencer {
  constructor({ db, leads, client, personalizer, rateLimiter, notifier, config, clock, logger }) {
    this.db = db;
    this.leads = leads;
    this.client = client;
    this.personalizer = personalizer;
    this.rate = rateLimiter;
    this.notifier = notifier;
    this.cfg = config;
    this.clock = clock || (() => new Date());
    this.log = logger || console.log;
  }

  async tick() {
    const now = this.clock();
    const summary = { ts: now.toISOString(), skipped: null, replies: [], connected: [], expired: [], sent: null };

    // 1) Warmup gate — refuse all real actions until warmup has passed.
    if (now < new Date(this.cfg.warmupUntil)) {
      summary.skipped = `warmup until ${this.cfg.warmupUntil}`;
      return summary;
    }

    // 2) Work hours gate.
    if (!this.rate.withinWorkHours(now)) {
      summary.skipped = 'off-hours';
      return summary;
    }

    // 3) Bookkeeping (reads only, no rate cost).
    await this._detectReplies(now, summary);
    await this._checkAcceptances(now, summary);
    this._expireFollowups(now, summary);

    // 4) At most one outbound send this tick (priority: nurture > new outreach).
    const sent =
      (await this._maybeFirstDm(now)) ||
      (await this._maybeFollowup(now, STATUS.MESSAGED, STATUS.FOLLOWUP_1, 'followup1_at', 2)) ||
      (await this._maybeFollowup(now, STATUS.FOLLOWUP_1, STATUS.FOLLOWUP_2, 'followup2_at', 3)) ||
      (await this._maybeInvite(now));
    summary.sent = sent;

    return summary;
  }

  // ---- bookkeeping ----------------------------------------------------------

  async _detectReplies(now, summary) {
    const watch = [STATUS.MESSAGED, STATUS.FOLLOWUP_1, STATUS.FOLLOWUP_2];
    for (const status of watch) {
      for (const lead of this.leads.byStatus(status)) {
        if (await this.client.hasReply(lead)) {
          this.leads.setStatus(lead.id, STATUS.REPLIED, { stampColumn: 'replied_at' }, now.toISOString());
          this.db.logEvent(lead.id, 'reply_detected', null, now.toISOString());
          await this.notifier.send(`💬 Reply from ${lead.name || lead.linkedin_url} — take over the conversation.`);
          summary.replies.push(lead.id);
        }
      }
    }
  }

  async _checkAcceptances(now, summary) {
    for (const lead of this.leads.byStatus(STATUS.INVITED)) {
      if (await this.client.isConnected(lead)) {
        this.leads.setStatus(lead.id, STATUS.CONNECTED, { stampColumn: 'connected_at' }, now.toISOString());
        this.db.logEvent(lead.id, 'invite_accepted', null, now.toISOString());
        summary.connected.push(lead.id);
      }
    }
  }

  _expireFollowups(now, summary) {
    for (const lead of this.leads.byStatus(STATUS.FOLLOWUP_2)) {
      if (daysSince(lead.followup2_at, now) >= this.cfg.sequence.daysBeforeDone) {
        this.leads.setStatus(lead.id, STATUS.DONE, { stampColumn: 'done_at' }, now.toISOString());
        this.db.logEvent(lead.id, 'sequence_done', null, now.toISOString());
        summary.expired.push(lead.id);
      }
    }
  }

  // ---- send actions (each returns a summary object or null) -----------------

  async _maybeFirstDm(now) {
    if (!this.rate.canMessage(now).ok) return null;
    for (const lead of this.leads.byStatus(STATUS.CONNECTED)) {
      if (daysSince(lead.connected_at, now) < this.cfg.sequence.daysBeforeFirstDm) continue;
      const text = await this.personalizer.message(lead, 1);
      const res = await this.client.sendMessage(lead, text);
      if (!res.ok) {
        this.db.logEvent(lead.id, 'message_failed', res.error, now.toISOString());
        continue;
      }
      this.leads.setStatus(lead.id, STATUS.MESSAGED, { stampColumn: 'messaged_at' }, now.toISOString());
      this.db.logEvent(lead.id, 'message_sent', 'dm1', now.toISOString());
      return { action: 'message', step: 1, leadId: lead.id, text };
    }
    return null;
  }

  async _maybeFollowup(now, fromStatus, toStatus, stampColumn, step) {
    if (!this.rate.canMessage(now).ok) return null;
    const waitDays =
      fromStatus === STATUS.MESSAGED
        ? this.cfg.sequence.daysBeforeFollowup1
        : this.cfg.sequence.daysBeforeFollowup2;
    const sinceCol = fromStatus === STATUS.MESSAGED ? 'messaged_at' : 'followup1_at';
    for (const lead of this.leads.byStatus(fromStatus)) {
      if (daysSince(lead[sinceCol], now) < waitDays) continue;
      const text = await this.personalizer.message(lead, step);
      const res = await this.client.sendMessage(lead, text);
      if (!res.ok) {
        this.db.logEvent(lead.id, 'message_failed', res.error, now.toISOString());
        continue;
      }
      this.leads.setStatus(lead.id, toStatus, { stampColumn }, now.toISOString());
      this.db.logEvent(lead.id, 'message_sent', `followup${step - 1}`, now.toISOString());
      return { action: 'message', step, leadId: lead.id, text };
    }
    return null;
  }

  async _maybeInvite(now) {
    const gate = this.rate.canInvite(now);
    if (!gate.ok) return null;
    const next = this.leads.byStatus(STATUS.NEW, 1)[0];
    if (!next) return null;
    const note = await this.personalizer.note(next);
    const res = await this.client.sendConnectionRequest(next, note);
    if (!res.ok) {
      this.leads.setStatus(next.id, STATUS.FAILED, { error: res.error }, now.toISOString());
      this.db.logEvent(next.id, 'invite_failed', res.error, now.toISOString());
      return { action: 'invite_failed', leadId: next.id, error: res.error };
    }
    this.leads.setStatus(next.id, STATUS.INVITED, { stampColumn: 'invited_at' }, now.toISOString());
    this.db.logEvent(next.id, 'invite_sent', null, now.toISOString());
    return { action: 'invite', leadId: next.id, note };
  }
}
