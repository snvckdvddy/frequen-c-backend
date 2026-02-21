/**
 * Push Notification Service — Expo Push API
 *
 * Sends push notifications to Expo push tokens via the Expo Push HTTP API.
 * No extra npm dependencies — uses native fetch (Node 18+).
 *
 * Noise Gate levels filter which notifications a user receives:
 *   - 'off'    → no push notifications at all
 *   - 'low'    → only critical: session ended, power moves on your track
 *   - 'medium' → above + track changes, participant joins (default)
 *   - 'high'   → everything (reactions, chat mentions, etc.)
 */

import db from '../database';

// ─── Types ───────────────────────────────────────────────────

export type NoiseGateLevel = 'off' | 'low' | 'medium' | 'high';

export type NotificationPriority = 'critical' | 'normal' | 'low';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Which noise gate levels should receive this notification */
  priority: NotificationPriority;
  /** Android notification channel */
  channelId?: string;
  sound?: string;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
}

// ─── Noise Gate Logic ────────────────────────────────────────

/** Map of priority → which noise gate levels allow it through */
const GATE_ALLOWS: Record<NotificationPriority, NoiseGateLevel[]> = {
  critical: ['low', 'medium', 'high'],  // Always through unless 'off'
  normal:   ['medium', 'high'],          // Default threshold
  low:      ['high'],                     // Only chatty users get these
};

function passesNoiseGate(userGateLevel: NoiseGateLevel, notifPriority: NotificationPriority): boolean {
  if (userGateLevel === 'off') return false;
  return GATE_ALLOWS[notifPriority].includes(userGateLevel);
}

// ─── Expo Push API ───────────────────────────────────────────

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Batch-send to Expo Push API. Handles chunking (max 100 per request). */
async function sendToExpo(messages: ExpoPushMessage[]): Promise<void> {
  if (messages.length === 0) return;

  // Expo allows up to 100 messages per request
  const chunks: ExpoPushMessage[][] = [];
  for (let i = 0; i < messages.length; i += 100) {
    chunks.push(messages.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify(chunk),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[Push] Expo API error (${res.status}):`, errText);
      } else {
        const data = await res.json() as any;
        // Log any ticket-level errors (invalid tokens, etc.)
        if (data?.data) {
          for (const ticket of data.data) {
            if (ticket.status === 'error') {
              console.warn(`[Push] Ticket error:`, ticket.message, ticket.details);
              // If token is invalid, clean it from DB
              if (ticket.details?.error === 'DeviceNotRegistered') {
                console.warn('[Push] Device not registered, token should be cleaned');
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[Push] Failed to send to Expo:', err);
    }
  }
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Send a push notification to specific users.
 * Respects each user's Noise Gate setting.
 */
export async function sendPush(userIds: string[], payload: PushPayload): Promise<void> {
  if (userIds.length === 0) return;

  // Fetch push tokens and noise gate preferences for all target users
  const placeholders = userIds.map(() => '?').join(',');
  const users = db.prepare(`
    SELECT id, push_token, noise_gate FROM users
    WHERE id IN (${placeholders}) AND push_token IS NOT NULL AND push_token != ''
  `).all(...userIds) as { id: string; push_token: string; noise_gate: string }[];

  const messages: ExpoPushMessage[] = [];

  for (const user of users) {
    const gateLevel = (user.noise_gate || 'medium') as NoiseGateLevel;

    // Check if notification passes this user's noise gate
    if (!passesNoiseGate(gateLevel, payload.priority)) {
      continue;
    }

    // Validate it's an Expo push token
    if (!user.push_token.startsWith('ExponentPushToken[')) {
      continue;
    }

    messages.push({
      to: user.push_token,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: payload.priority === 'critical' ? 'default' : null,
      channelId: payload.channelId || 'session',
      priority: payload.priority === 'critical' ? 'high' : 'normal',
    });
  }

  if (messages.length > 0) {
    console.log(`[Push] Sending ${messages.length} notification(s): "${payload.title}"`);
    // Fire and forget — don't block socket handlers
    sendToExpo(messages).catch((err) => console.error('[Push] Background send error:', err));
  }
}

/**
 * Send a push notification to all participants in a session,
 * optionally excluding specific user IDs (e.g., the sender).
 */
export async function sendPushToSession(
  sessionId: string,
  payload: PushPayload,
  excludeUserIds: string[] = [],
): Promise<void> {
  // Get all listeners in the session
  const listeners = db.prepare(
    'SELECT user_id FROM session_listeners WHERE session_id = ?'
  ).all(sessionId) as { user_id: string }[];

  const targetIds = listeners
    .map((l) => l.user_id)
    .filter((id) => !excludeUserIds.includes(id));

  await sendPush(targetIds, payload);
}

/**
 * Send a push notification to the host of a session.
 */
export async function sendPushToHost(
  sessionId: string,
  payload: PushPayload,
): Promise<void> {
  const session = db.prepare('SELECT host_id FROM sessions WHERE id = ?').get(sessionId) as any;
  if (session?.host_id) {
    await sendPush([session.host_id], payload);
  }
}

export default {
  sendPush,
  sendPushToSession,
  sendPushToHost,
};
