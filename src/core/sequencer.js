// The brain. One `tick()` performs all safe bookkeeping (reply detection,
// acceptance checks, stale-invite withdrawals, expiries) plus AT MOST ONE
// outbound "send" action, to stay human-like. A runner calls tick() repeatedly
// with jittered delays.
//
// Bookkeeping is THROTTLED: instead of re-checking every in-flight lead each
// tick (which, on a real browser driver, would mean dozens of profile/inbox
// navigations per tick — slow and very bot-like), each lead is re-checked at
// most every `checks.intervalHours`, and only `checks.maxPerTick` leads/tick.
//
// A CIRCUIT BREAKER protects the account: if the driver reports a checkpoint /
// auth wall (`client.isBlocked()`), all sending stops, a one-time alert fires,
// and the breaker stays active (persisted via a `circuit_break` event) for
// `safety.breakerCooldownHours` — so even cron `--once` runs stay dark.
//
// Everything time-related goes through `clock()` so tests control the clock.

import { STATUS } from '../db/leads.js';
import { NullEmailClient } from '../email/EmailClient.js';
import { breakerActive, tripBreaker } from './breaker.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const daysSince = (iso, now) => (iso ? (now.getTime() - new Date(iso).getTime()) / DAY : Infinity);

export class Sequencer {
  constructor({ db, leads, client, personalizer, rateLimiter, notifier, config, clock, logger, email }) {
    this.db = db;
    this.leads = leads;
    this.client = client;
    this.email = email || new NullEmailClient();
    this.personalizer = personalizer;
    this.rate = rateLimiter;
    this.notifier = notifier;
    this.cfg = config;
    this.clock = clock || (() => new Date());
    this.log = logger || console.log;
  }

  async tick() {
    const now = this.clock();
    const summary = {
      ts: now.toISOString(),
      skipped: null,
      replies: [],
      connected: [],
      withdrawn: [],
      enrolled: [],
      expired: [],
      sent: null,
    };

    // 0) Circuit breaker — if a checkpoint/ban was seen recently, stay fully dark.
    if (this._breakerActive(now)) {
      summary.skipped = 'circuit-breaker active (LinkedIn checkpoint detected)';
      return summary;
    }

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

    // 3) Bookkeeping (throttled reads + bounded stale-invite withdrawals).
    await this._runChecks(now, summary);
    if (await this._tripIfBlocked(now, summary)) return summary;
    await this._withdrawStaleInvites(now, summary);
    if (await this._tripIfBlocked(now, summary)) return summary;
    await this._checkEmailReplies(now, summary);
    this._expireFollowups(now, summary);

    // 4) At most one outbound send this tick (priority: nurture > new outreach).
    const sent =
      (await this._maybeFirstDm(now)) ||
      (await this._maybeFollowup(now, STATUS.MESSAGED, STATUS.FOLLOWUP_1, 'followup1_at', 2)) ||
      (await this._maybeFollowup(now, STATUS.FOLLOWUP_1, STATUS.FOLLOWUP_2, 'followup2_at', 3)) ||
      (await this._maybeInvite(now));
    summary.sent = sent;
    if (await this._tripIfBlocked(now, summary)) return summary;

    return summary;
  }

  // ---- circuit breaker ------------------------------------------------------

  _breakerActive(now) {
    return breakerActive(this.db, this.cfg, now);
  }

  // If the driver is now blocked, trip the breaker: record it (once per cooldown),
  // alert, and mark the tick skipped. Returns true if blocked.
  async _tripIfBlocked(now, summary) {
    if (!this.client.isBlocked || !this.client.isBlocked()) return false;
    await tripBreaker(this.db, this.notifier, this.cfg, now);
    summary.skipped = 'circuit-breaker tripped (LinkedIn checkpoint detected)';
    return true;
  }

  // ---- bookkeeping ----------------------------------------------------------

  // Throttled status re-checks across all in-flight leads. A single shared budget
  // (oldest-checked first) covers both acceptance detection (invited) and reply
  // detection (messaged/followups), so neither starves the other.
  async _runChecks(now, summary) {
    const nowIso = now.toISOString();
    const cutoff = new Date(now.getTime() - this.cfg.checks.intervalHours * HOUR).toISOString();
    const watch = [STATUS.INVITED, STATUS.MESSAGED, STATUS.FOLLOWUP_1, STATUS.FOLLOWUP_2];
    const due = this.leads.dueForCheck(watch, cutoff, this.cfg.checks.maxPerTick);

    for (const lead of due) {
      if (lead.status === STATUS.INVITED) {
        if (await this.client.isConnected(lead)) {
          this.leads.setStatus(lead.id, STATUS.CONNECTED, { stampColumn: 'connected_at' }, nowIso);
          this.db.logEvent(lead.id, 'invite_accepted', null, nowIso);
          summary.connected.push(lead.id);
        }
      } else if (await this.client.hasReply(lead)) {
        await this._markReplied(lead, 'linkedin', now);
        summary.replies.push(lead.id);
      }
      this.leads.markChecked(lead.id, nowIso);
      if (this.client.isBlocked && this.client.isBlocked()) break;
    }
  }

  // Pull a lead out of the machine on a reply (on either channel) and, if it was
  // also enrolled in email, pause that sequence so we never double-touch.
  async _markReplied(lead, channel, now) {
    const nowIso = now.toISOString();
    this.leads.setStatus(lead.id, STATUS.REPLIED, { stampColumn: 'replied_at' }, nowIso);
    this.db.logEvent(lead.id, 'reply_detected', channel, nowIso);
    if (this.email.enabled && lead.email_enrolled_at) {
      const res = await this.email.pause(lead);
      if (res.ok) this.db.logEvent(lead.id, 'email_paused', channel, nowIso);
    }
    await this.notifier.send(
      `💬 Reply from ${lead.name || lead.linkedin_url} (${channel}) — take over the conversation.`
    );
  }

  // Watch email-enrolled leads for a reply on the email channel. Throttled like
  // the LinkedIn checks (shared last_checked_at + maxPerTick budget).
  async _checkEmailReplies(now, summary) {
    if (!this.email.enabled) return;
    const nowIso = now.toISOString();
    const cutoff = new Date(now.getTime() - this.cfg.checks.intervalHours * HOUR).toISOString();
    const due = this.leads.emailDueForCheck(cutoff, this.cfg.checks.maxPerTick);
    for (const lead of due) {
      try {
        if (await this.email.hasReply(lead)) {
          await this._markReplied(lead, 'email', now);
          summary.replies.push(lead.id);
        }
      } catch (err) {
        this.log(`[email] hasReply error: ${err.message}`);
      }
      this.leads.markChecked(lead.id, nowIso);
    }
  }

  // Withdraw connection requests that have been pending too long. Bounded per tick
  // so it never turns into a burst of activity.
  async _withdrawStaleInvites(now, summary) {
    const nowIso = now.toISOString();
    const stale = this.leads
      .byStatus(STATUS.INVITED)
      .filter((l) => daysSince(l.invited_at, now) >= this.cfg.invites.withdrawAfterDays)
      .slice(0, this.cfg.invites.maxWithdrawalsPerTick);

    for (const lead of stale) {
      const res = await this.client.withdrawInvite(lead);
      if (res.ok) {
        this.leads.setStatus(lead.id, STATUS.WITHDRAWN, { stampColumn: 'withdrawn_at' }, nowIso);
        this.db.logEvent(lead.id, 'invite_withdrawn', null, nowIso);
        summary.withdrawn.push(lead.id);
        // LinkedIn didn't connect — hand the lead to email as the fallback channel.
        await this._maybeEnrollEmail(lead, now, summary);
      } else {
        this.db.logEvent(lead.id, 'withdraw_failed', res.error, nowIso);
      }
      if (this.client.isBlocked && this.client.isBlocked()) break;
    }
  }

  // Enroll a lead into the email channel if it's enabled, configured to hand off,
  // the lead has an email, and it isn't already enrolled.
  async _maybeEnrollEmail(lead, now, summary) {
    if (!this.email.enabled || !this.cfg.email.handoffOnWithdraw) return;
    if (!lead.email || lead.email_enrolled_at) return;
    const nowIso = now.toISOString();
    const res = await this.email.enroll(lead);
    if (res.ok) {
      this.leads.markEmailEnrolled(lead.id, nowIso);
      this.db.logEvent(lead.id, 'email_enrolled', null, nowIso);
      summary.enrolled.push(lead.id);
    } else if (!res.skipped) {
      this.db.logEvent(lead.id, 'email_enroll_failed', res.error, nowIso);
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
        if (this.client.isBlocked && this.client.isBlocked()) break;
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
        if (this.client.isBlocked && this.client.isBlocked()) break;
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

    // Decide whether to attach a note: LinkedIn caps NOTED invites per month.
    // Once that budget is spent, keep inviting without a note rather than failing.
    let useNote = this.cfg.invites.attachNote;
    if (useNote && this.cfg.invites.maxNotedPerMonth > 0) {
      const noted = this.db.countEventsSince('invite_sent', MONTH, now, 'noted');
      if (noted >= this.cfg.invites.maxNotedPerMonth) useNote = false;
    }

    const note = useNote ? await this.personalizer.note(next) : null;
    const res = await this.client.sendConnectionRequest(next, note);
    const nowIso = now.toISOString();
    if (!res.ok) {
      // Already a 1st-degree connection: skip the invite, jump straight to the DM track.
      if (res.reason === 'already_connected') {
        this.leads.setStatus(next.id, STATUS.CONNECTED, { stampColumn: 'connected_at' }, nowIso);
        this.db.logEvent(next.id, 'already_connected', null, nowIso);
        return { action: 'already_connected', leadId: next.id };
      }
      // Invite already pending (e.g. sent manually): track it instead of failing.
      if (res.reason === 'pending') {
        this.leads.setStatus(next.id, STATUS.INVITED, { stampColumn: 'invited_at' }, nowIso);
        this.db.logEvent(next.id, 'invite_pending', null, nowIso);
        return { action: 'invite_pending', leadId: next.id };
      }
      this.leads.setStatus(next.id, STATUS.FAILED, { error: res.error }, nowIso);
      this.db.logEvent(next.id, 'invite_failed', res.error, nowIso);
      return { action: 'invite_failed', leadId: next.id, error: res.error };
    }
    this.leads.setStatus(next.id, STATUS.INVITED, { stampColumn: 'invited_at' }, nowIso);
    this.db.logEvent(next.id, 'invite_sent', useNote ? 'noted' : 'plain', nowIso);
    return { action: 'invite', leadId: next.id, note, noted: useNote };
  }
}
