// The inbound brain. One tick() does the content-driven loop, each part bounded
// per tick to stay human-like:
//   1) publish a due scheduled post
//   2) scan published posts for trigger-word comments -> create engagements
//   3) auto-accept pending invites from people who engaged
//   4) DM the magnet (with a tracked link) to new engagements
//   5) detect replies on delivered engagements -> hand the conversation to you
//
// Shares ban-safety with the outbound machine: warmup gate, work hours, the
// daily message cap (RateLimiter), and the persisted circuit breaker.

import { ENGAGEMENT_STATUS as ES } from '../db/engagements.js';
import { breakerActive, tripBreaker } from '../core/breaker.js';
import { NullCrmClient } from '../crm/CrmClient.js';
import { syncEngagementToCrm } from '../crm/index.js';

const HOUR = 3600 * 1000;
const firstName = (name) => (name ? name.trim().split(/\s+/)[0] : 'there');

export class InboundSequencer {
  constructor({ db, magnets, posts, engagements, client, rateLimiter, notifier, config, clock, logger, crm }) {
    this.db = db;
    this.magnets = magnets;
    this.posts = posts;
    this.engagements = engagements;
    this.client = client;
    this.crm = crm || new NullCrmClient();
    this.rate = rateLimiter;
    this.notifier = notifier;
    this.cfg = config;
    this.clock = clock || (() => new Date());
    this.log = logger || console.log;
  }

  async tick() {
    const now = this.clock();
    const summary = { ts: now.toISOString(), skipped: null, published: [], engaged: [], accepted: [], delivered: [], replies: [] };

    if (breakerActive(this.db, this.cfg, now)) {
      summary.skipped = 'circuit-breaker active (LinkedIn checkpoint detected)';
      return summary;
    }
    if (now < new Date(this.cfg.warmupUntil)) {
      summary.skipped = `warmup until ${this.cfg.warmupUntil}`;
      return summary;
    }
    if (!this.rate.withinWorkHours(now)) {
      summary.skipped = 'off-hours';
      return summary;
    }

    await this._publishDuePosts(now, summary);
    if (await this._tripIfBlocked(now, summary)) return summary;
    await this._scanComments(now, summary);
    if (await this._tripIfBlocked(now, summary)) return summary;
    await this._acceptEngagedInvites(now, summary);
    if (await this._tripIfBlocked(now, summary)) return summary;
    await this._deliverMagnets(now, summary);
    if (await this._tripIfBlocked(now, summary)) return summary;
    await this._detectReplies(now, summary);
    await this._tripIfBlocked(now, summary);

    return summary;
  }

  async _tripIfBlocked(now, summary) {
    if (!this.client.isBlocked || !this.client.isBlocked()) return false;
    await tripBreaker(this.db, this.notifier, this.cfg, now);
    summary.skipped = 'circuit-breaker tripped (LinkedIn checkpoint detected)';
    return true;
  }

  // 1) Publish due scheduled posts.
  async _publishDuePosts(now, summary) {
    const due = this.posts.due(now.toISOString(), this.cfg.inbound.maxPostsPerTick);
    for (const post of due) {
      const res = await this.client.publishPost(post.body);
      if (res.ok) {
        this.posts.markPublished(post.id, res.ref, now.toISOString());
        this.db.logEvent(post.id, 'post_published', post.hook, now.toISOString());
        summary.published.push(post.id);
      } else {
        this.posts.markFailed(post.id, res.error, now.toISOString());
        this.db.logEvent(post.id, 'post_failed', res.error, now.toISOString());
      }
      if (this.client.isBlocked && this.client.isBlocked()) break;
    }
  }

  // 2) Scan published posts for trigger-word comments -> engagements.
  async _scanComments(now, summary) {
    const cutoff = new Date(now.getTime() - this.cfg.inbound.scanIntervalHours * HOUR).toISOString();
    const toScan = this.posts.needingScan(cutoff, this.cfg.inbound.maxScansPerTick);

    for (const post of toScan) {
      // Each post carries its own (campaign) trigger word; fall back to the env default.
      const trigger = new RegExp(this._escape(post.trigger_word || this.cfg.inbound.triggerWord), 'i');
      let comments = [];
      try {
        comments = await this.client.getPostComments(post);
      } catch (err) {
        this.log(`[inbound] getPostComments error: ${err.message}`);
      }
      for (const c of comments || []) {
        if (!trigger.test(c.text || '')) continue;
        const { id, created } = this.engagements.upsert(
          {
            post_id: post.id,
            magnet_id: post.magnet_id,
            name: c.name,
            linkedin_url: c.profileUrl,
            profile_ref: c.profileRef,
            source: 'comment',
            comment_text: c.text,
          },
          now.toISOString()
        );
        if (created) {
          this.db.logEvent(id, 'engagement_captured', String(post.id), now.toISOString());
          summary.engaged.push(id);
        }
      }
      this.posts.markScanned(post.id, now.toISOString());
      if (this.client.isBlocked && this.client.isBlocked()) break;
    }
  }

  // 3) Auto-accept pending invites from people who engaged (not random invites).
  async _acceptEngagedInvites(now, summary) {
    if (!this.cfg.inbound.autoAccept) return;
    let pending = [];
    try {
      pending = await this.client.getPendingInvites();
    } catch (err) {
      this.log(`[inbound] getPendingInvites error: ${err.message}`);
      return;
    }
    let budget = this.cfg.inbound.maxScansPerTick;
    for (const inv of pending || []) {
      if (budget <= 0) break;
      if (!this._isEngaged(inv.profileRef)) continue;
      const res = await this.client.acceptInvite(inv);
      if (res.ok) {
        this.db.logEvent(null, 'inbound_invite_accepted', inv.profileRef || inv.name || null, now.toISOString());
        summary.accepted.push(inv.profileRef || inv.name);
        budget--;
      }
      if (this.client.isBlocked && this.client.isBlocked()) break;
    }
  }

  _isEngaged(profileRef) {
    if (!profileRef) return false;
    return Boolean(this.db.get(`SELECT id FROM engagements WHERE profile_ref = $ref LIMIT 1`, { ref: profileRef }));
  }

  // 4) DM the magnet (with a tracked link) to engaged people. Shares the daily
  //    message cap; bounded per tick.
  async _deliverMagnets(now, summary) {
    let budget = this.cfg.inbound.maxDmsPerTick;
    for (const e of this.engagements.byStatus(ES.ENGAGED)) {
      if (budget <= 0) break;
      if (!this.rate.canMessage(now).ok) break;
      const magnet = e.magnet_id ? this.magnets.byId(e.magnet_id) : null;
      const text = this._deliveryMessage(e, magnet);
      const res = await this.client.sendMessage({ linkedin_url: e.linkedin_url, name: e.name }, text);
      if (!res.ok) {
        this.engagements.setStatus(e.id, ES.ENGAGED, { error: res.error }, now.toISOString());
        this.db.logEvent(e.id, 'inbound_dm_failed', res.error, now.toISOString());
        if (this.client.isBlocked && this.client.isBlocked()) break;
        continue;
      }
      // dm mode: the magnet link is in the DM, so it's delivered. gated mode: the
      // email is captured on the landing page, so we only mark dm_sent here.
      const delivered = this._delivery(magnet) === 'dm';
      this.engagements.setStatus(
        e.id,
        delivered ? ES.DELIVERED : ES.DM_SENT,
        { stampColumn: delivered ? 'delivered_at' : 'dm_sent_at' },
        now.toISOString()
      );
      this.db.logEvent(e.id, 'message_sent', 'inbound_magnet', now.toISOString());
      summary.delivered.push(e.id);
      budget--;
      if (this.client.isBlocked && this.client.isBlocked()) break;
    }
  }

  // Delivery mode is a property of the magnet (set from its campaign); the env
  // value is only a fallback.
  _delivery(magnet) {
    return magnet?.delivery || this.cfg.inbound.deliveryMode;
  }

  _deliveryMessage(e, magnet) {
    const fn = firstName(e.name);
    const name = magnet?.name || 'the resource';
    const link = `${this.cfg.inbound.captureBaseUrl}/m/${magnet?.slug || 'resource'}?e=${e.id}`;
    if (this._delivery(magnet) === 'gated') {
      return `Hey ${fn}, happy to send "${name}"! Grab it here (drop your email so I can send it over): ${link}`;
    }
    return `Hey ${fn}, here's "${name}" as promised: ${link} — hope it's useful. Happy to answer any questions.`;
  }

  // 5) Detect replies on delivered/dm_sent engagements -> hand over. Throttled.
  async _detectReplies(now, summary) {
    const cutoff = new Date(now.getTime() - this.cfg.checks.intervalHours * HOUR).toISOString();
    const due = this.engagements.dueForCheck([ES.DM_SENT, ES.DELIVERED], cutoff, this.cfg.checks.maxPerTick);
    for (const e of due) {
      if (await this.client.hasReply({ linkedin_url: e.linkedin_url, name: e.name })) {
        this.engagements.setStatus(e.id, ES.REPLIED, { stampColumn: 'replied_at' }, now.toISOString());
        this.db.logEvent(e.id, 'inbound_reply', null, now.toISOString());
        if (['reply', 'both'].includes(this.cfg.crm.createOn)) {
          await syncEngagementToCrm(this.crm, this.engagements, this.db, e, now);
        }
        await this.notifier.send(`💬 ${e.name || 'A lead'} replied to your magnet DM — take over the conversation.`);
        summary.replies.push(e.id);
      }
      this.engagements.markChecked(e.id, now.toISOString());
      if (this.client.isBlocked && this.client.isBlocked()) break;
    }
  }

  _escape(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
