// Enforces conservative, ban-avoiding limits. All checks read counts from the
// events table so they survive restarts. `now` is injectable for testing.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export class RateLimiter {
  constructor(db, config) {
    this.db = db;
    this.cfg = config;
  }

  // Effective invites/day, linearly ramped from rampUpStartInvites up to the
  // configured cap over rampUpDays, counted from the first invite ever sent.
  effectiveInvitesPerDay(now = new Date()) {
    const { invitesPerDay, rampUpDays, rampUpStartInvites } = this.cfg.limits;
    if (rampUpDays <= 0) return invitesPerDay;

    const firstIso = this.db.firstEventTime('invite_sent');
    if (!firstIso) return rampUpStartInvites; // day 0, nothing sent yet

    const dayIndex = Math.floor((now.getTime() - new Date(firstIso).getTime()) / DAY);
    if (dayIndex >= rampUpDays) return invitesPerDay;

    const step = (invitesPerDay - rampUpStartInvites) / rampUpDays;
    return Math.min(invitesPerDay, Math.floor(rampUpStartInvites + step * dayIndex));
  }

  canInvite(now = new Date()) {
    const l = this.cfg.limits;
    const perDay = this.effectiveInvitesPerDay(now);
    const day = this.db.countEventsSince('invite_sent', DAY, now);
    if (day >= perDay) return { ok: false, reason: `daily invite cap (${day}/${perDay})` };
    const hour = this.db.countEventsSince('invite_sent', HOUR, now);
    if (hour >= l.invitesPerHour) return { ok: false, reason: `hourly invite cap (${hour}/${l.invitesPerHour})` };
    const week = this.db.countEventsSince('invite_sent', WEEK, now);
    if (week >= l.invitesPerWeek) return { ok: false, reason: `weekly invite cap (${week}/${l.invitesPerWeek})` };
    return { ok: true };
  }

  canMessage(now = new Date()) {
    const day = this.db.countEventsSince('message_sent', DAY, now);
    if (day >= this.cfg.limits.messagesPerDay) {
      return { ok: false, reason: `daily message cap (${day}/${this.cfg.limits.messagesPerDay})` };
    }
    return { ok: true };
  }

  // True if `now` falls inside configured work days + hours (local server time).
  withinWorkHours(now = new Date()) {
    const { hoursStart, hoursEnd, days } = this.cfg.work;
    const dow = ((now.getDay() + 6) % 7) + 1; // JS Sun=0 -> ISO Mon=1..Sun=7
    if (!days.includes(dow)) return false;
    const h = now.getHours();
    return h >= hoursStart && h < hoursEnd;
  }
}
