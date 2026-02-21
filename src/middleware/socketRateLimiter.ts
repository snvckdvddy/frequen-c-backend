/**
 * Socket.io Per-User Rate Limiter
 *
 * Tracks event emissions per user (by userId, not IP) with configurable
 * cooldowns per event type. Returns false if the action is rate-limited.
 *
 * Usage in socketHandler:
 *   if (!socketLimiter.canDo(socket.userId, 'add-to-queue')) {
 *     socket.emit('error', { message: 'Too fast, slow down' });
 *     return;
 *   }
 */

interface CooldownEntry {
  lastAction: number;
}

// Per-user, per-event cooldown tracking
const cooldowns: Record<string, Record<string, CooldownEntry>> = {};

/** Cooldown durations in ms per event type */
const EVENT_COOLDOWNS: Record<string, number> = {
  'add-to-queue':   2000,   // 1 track every 2s
  'vote-track':     1000,   // 1 vote per second
  'reaction':       300,    // rapid tapping OK
  'skip-track':     1500,   // no spam-skipping
  'chat-message':   500,    // 2 messages/sec max
  'approve-track':  500,
  'reject-track':   500,
  'change-mode':    3000,   // no mode-thrashing
  'end-session':    5000,   // one-shot protection
  'duel-vote':      5000,
  'forecast-pick':  5000,
  'phantom-power':  3000,
};

/**
 * Check if a user can perform an action. Returns true if allowed, false if rate-limited.
 * Automatically records the action if allowed.
 */
export function canDo(userId: string, event: string): boolean {
  const cooldownMs = EVENT_COOLDOWNS[event];
  if (!cooldownMs) return true; // No cooldown configured = always allow

  if (!cooldowns[userId]) cooldowns[userId] = {};

  const entry = cooldowns[userId][event];
  const now = Date.now();

  if (entry && now - entry.lastAction < cooldownMs) {
    return false;
  }

  cooldowns[userId][event] = { lastAction: now };
  return true;
}

/** Clean up disconnected users (call on socket disconnect) */
export function clearUser(userId: string): void {
  delete cooldowns[userId];
}

// Periodic cleanup of stale entries (users who disconnected without cleanup)
setInterval(() => {
  const staleThreshold = 10 * 60 * 1000; // 10 min
  const now = Date.now();
  for (const userId of Object.keys(cooldowns)) {
    const events = cooldowns[userId];
    const allStale = Object.values(events).every(
      (e) => now - e.lastAction > staleThreshold
    );
    if (allStale) delete cooldowns[userId];
  }
}, 5 * 60 * 1000);
