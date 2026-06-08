// Shared circuit breaker, persisted via a `circuit_break` event so it survives
// restarts (cron --once respects it too). Used by both the outbound and inbound
// sequencers — a checkpoint detected by either pauses everything.

const HOUR = 3600 * 1000;

export function breakerActive(db, cfg, now) {
  const last = db.lastEventTime('circuit_break');
  if (!last) return false;
  return now.getTime() - new Date(last).getTime() < cfg.safety.breakerCooldownHours * HOUR;
}

// Records the trip once per cooldown window and alerts. Safe to call repeatedly.
export async function tripBreaker(db, notifier, cfg, now) {
  if (!breakerActive(db, cfg, now)) {
    db.logEvent(null, 'circuit_break', 'linkedin checkpoint/auth wall detected', now.toISOString());
    await notifier.send(
      '🛑 Circuit breaker tripped: LinkedIn showed a checkpoint / auth wall. ' +
        'All sending is paused. Log in manually and investigate before resuming.'
    );
  }
}
