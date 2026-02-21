/**
 * Session Reaper — Cleans up stale sessions
 *
 * Runs on an interval, marking sessions as not-live if they've been
 * idle beyond the threshold. Prevents zombie rooms from cluttering
 * the Live Grid.
 *
 * "Idle" = no listeners in the Socket.io room (everyone disconnected).
 * We check session_listeners count vs active socket room members.
 *
 * For simplicity (no io reference needed), we use a time-based approach:
 * sessions created > MAX_AGE_HOURS ago that are still marked live get reaped.
 */

import db from '../database';

/** Max session lifetime in hours before auto-reap */
const MAX_AGE_HOURS = parseInt(process.env.SESSION_MAX_AGE_HOURS || '24', 10);

/** Reap interval in minutes */
const REAP_INTERVAL_MIN = 15;

function reapStaleSessions(): void {
  const cutoff = new Date(Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();

  // Find live sessions older than cutoff
  const stale = db.prepare(`
    SELECT id, name FROM sessions
    WHERE is_live = 1 AND created_at < ?
  `).all(cutoff) as any[];

  if (stale.length === 0) return;

  console.log(`[Reaper] Found ${stale.length} stale session(s), cleaning up...`);

  const markDead = db.prepare('UPDATE sessions SET is_live = 0 WHERE id = ?');
  const clearQueue = db.prepare('DELETE FROM queue_tracks WHERE session_id = ?');
  const clearListeners = db.prepare('DELETE FROM session_listeners WHERE session_id = ?');

  const reapTransaction = db.transaction((sessions: any[]) => {
    for (const s of sessions) {
      markDead.run(s.id);
      clearQueue.run(s.id);
      clearListeners.run(s.id);
      console.log(`[Reaper] Reaped: "${s.name}" (${s.id})`);
    }
  });

  reapTransaction(stale);
}

/** Start the periodic reaper. Returns the interval ID for cleanup. */
export function startSessionReaper(): ReturnType<typeof setInterval> {
  // Run once on startup
  reapStaleSessions();

  // Then every REAP_INTERVAL_MIN
  const interval = setInterval(reapStaleSessions, REAP_INTERVAL_MIN * 60 * 1000);
  console.log(`[Reaper] Session reaper active (max age: ${MAX_AGE_HOURS}h, interval: ${REAP_INTERVAL_MIN}min)`);
  return interval;
}
