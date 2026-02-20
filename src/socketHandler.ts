/**
 * Socket.io Event Handler
 *
 * Manages real-time events: join/leave, queue ops, voting, reactions, chat, mode changes.
 * Each socket authenticates via JWT in the auth handshake.
 */

import { Server, Socket } from 'socket.io';
import { v4 as uuid } from 'uuid';
import db from './database';
import { verifyToken, JwtPayload } from './auth';
import { formatQueueTrack } from './routes/sessionRoutes';

interface AuthenticatedSocket extends Socket {
  userId: string;
  username: string;
}

/** In-memory playback state per session (not persisted — resets on server restart). */
interface PlaybackState {
  state: 'playing' | 'paused' | 'stopped';
  position: number;      // seconds into the track
  timestamp: number;     // Date.now() when position was recorded
  trackId?: string;
}

const roomPlaybackState: Record<string, PlaybackState> = {};

export function setupSocketHandlers(io: Server): void {
  // Auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const payload: JwtPayload = verifyToken(token);
      (socket as AuthenticatedSocket).userId = payload.userId;
      (socket as AuthenticatedSocket).username = payload.username;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (rawSocket: Socket) => {
    const socket = rawSocket as AuthenticatedSocket;
    console.log(`[Socket] ${socket.username} connected (${socket.id})`);

    // ─── Join Session ────────────────────────────────────────
    socket.on('join-session', ({ sessionId }: { sessionId: string }) => {
      socket.join(sessionId);

      // Upsert listener
      db.prepare(`
        INSERT OR IGNORE INTO session_listeners (session_id, user_id)
        VALUES (?, ?)
      `).run(sessionId, socket.userId);

      // Broadcast to room (everyone else)
      socket.to(sessionId).emit('participant-joined', {
        userId: socket.userId,
        username: socket.username,
      });

      // ── Send full room state back to the joining user ──
      const session = db.prepare(`
        SELECT s.*, u.username as host_username
        FROM sessions s JOIN users u ON s.host_id = u.id
        WHERE s.id = ?
      `).get(sessionId) as any;

      if (session) {
        const participants = db.prepare(`
          SELECT u.id as userId, u.username, u.avatar_url as avatarUrl
          FROM session_listeners sl JOIN users u ON sl.user_id = u.id
          WHERE sl.session_id = ?
        `).all(sessionId) as any[];

        const currentTrack = db.prepare(
          'SELECT * FROM queue_tracks WHERE session_id = ? AND is_current = 1 LIMIT 1'
        ).get(sessionId) as any;

        const queueRows = getOrderedQueue(sessionId);

        // Get pending tracks for Spotlight mode
        const pendingRows = db.prepare(`
          SELECT * FROM queue_tracks
          WHERE session_id = ? AND status = 'pending'
          ORDER BY position ASC
        `).all(sessionId) as any[];

        const recentChat = db.prepare(
          'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 50'
        ).all(sessionId) as any[];

        socket.emit('room-state', {
          sessionId,
          roomMode: session.room_mode,
          hostId: session.host_id,
          hostUsername: session.host_username,
          participants: participants.map((p: any) => ({
            userId: p.userId,
            username: p.username,
            avatarUrl: p.avatarUrl || undefined,
          })),
          currentTrack: currentTrack ? formatQueueTrack(currentTrack) : null,
          queue: queueRows.map(formatQueueTrack),
          suggestedQueue: pendingRows.map(formatQueueTrack),
          chat: recentChat.reverse().map((m: any) => ({
            id: m.id,
            userId: m.user_id,
            username: m.username,
            text: m.text,
            type: m.type,
            timestamp: m.timestamp,
          })),
          playback: roomPlaybackState[sessionId] || { state: 'stopped', position: 0, timestamp: Date.now() },
        });
      }

      console.log(`[Socket] ${socket.username} joined room ${sessionId}`);
    });

    // ─── Leave Session (navigate away — keep membership) ─────
    socket.on('leave-session', ({ sessionId }: { sessionId: string }) => {
      socket.leave(sessionId);
      // Notify others you're no longer actively viewing, but keep session_listeners row
      io.to(sessionId).emit('participant-left', { userId: socket.userId });
    });

    // ─── Quit Session (permanently leave — remove membership) ─
    socket.on('quit-session', ({ sessionId }: { sessionId: string }) => {
      socket.leave(sessionId);
      db.prepare('DELETE FROM session_listeners WHERE session_id = ? AND user_id = ?')
        .run(sessionId, socket.userId);
      io.to(sessionId).emit('participant-left', { userId: socket.userId });
    });

    // ─── Add to Queue ────────────────────────────────────────
    socket.on('add-to-queue', ({ sessionId, track }: { sessionId: string; track: any }) => {
      console.log(`[Socket] add-to-queue from ${socket.username}: "${track?.title}" → session ${sessionId}`);

      try {
        // Always generate a unique queue-entry ID — the same song can be
        // added to multiple sessions or even twice in the same session.
        const trackId = 'qt_' + uuid().slice(0, 12);

        // Get next position
        const maxPos = db.prepare(
          'SELECT COALESCE(MAX(position), -1) as maxPos FROM queue_tracks WHERE session_id = ?'
        ).get(sessionId) as any;

        const position = (maxPos?.maxPos ?? -1) + 1;

        // Check room mode for status — host tracks bypass pending in spotlight
        const session = db.prepare('SELECT room_mode, host_id FROM sessions WHERE id = ?').get(sessionId) as any;
        const isHost = session?.host_id === socket.userId;
        const status = (session?.room_mode === 'spotlight' && !isHost) ? 'pending' : 'approved';

        db.prepare(`
          INSERT INTO queue_tracks (id, session_id, title, artist, album, album_art, preview_url, duration, source, source_id, added_by_id, added_by_username, status, position)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          trackId, sessionId,
          track.title, track.artist, track.album || null, track.albumArt || null,
          track.previewUrl || null, track.duration || 30,
          track.source || 'itunes', track.sourceId || null,
          socket.userId, socket.username,
          status, position
        );

        // Increment user's tracks_added
        db.prepare('UPDATE users SET tracks_added = tracks_added + 1 WHERE id = ?').run(socket.userId);

        // Broadcast updated queue (approved tracks only)
        broadcastQueue(io, sessionId);

        // Spotlight mode: notify room that a track is pending approval
        if (status === 'pending') {
          const pendingRow = db.prepare('SELECT * FROM queue_tracks WHERE id = ?').get(trackId) as any;
          io.to(sessionId).emit('track-pending', { track: formatQueueTrack(pendingRow) });
        }

        // If this is the first track and no current track, set it as current
        const currentTrack = db.prepare(
          'SELECT id FROM queue_tracks WHERE session_id = ? AND is_current = 1'
        ).get(sessionId);

        if (!currentTrack && status === 'approved') {
          db.prepare('UPDATE queue_tracks SET is_current = 1 WHERE id = ?').run(trackId);
          const newCurrent = db.prepare('SELECT * FROM queue_tracks WHERE id = ?').get(trackId) as any;
          io.to(sessionId).emit('track-changed', formatQueueTrack(newCurrent));
        }

        console.log(`[Socket] Track "${track?.title}" added to queue (${trackId}) in session ${sessionId}`);
      } catch (err: any) {
        console.error(`[Socket] add-to-queue error:`, err.message);
        // Don't crash — just notify the client
        socket.emit('error', { message: 'Failed to add track to queue' });
      }
    });

    // ─── Vote Track ──────────────────────────────────────────
    socket.on('vote-track', ({ sessionId, trackId, direction }: { sessionId: string; trackId: string; direction: number | string }) => {
      // Mobile sends 1/-1 (number), normalize to number either way
      const voteDir = (direction === 1 || direction === 'up') ? 1 : -1;
      const track = db.prepare('SELECT * FROM queue_tracks WHERE id = ?').get(trackId) as any;
      if (!track) return;

      const votedBy = JSON.parse(track.voted_by || '{}');
      const prevVote = votedBy[socket.userId] || 0;

      // Toggle or change vote
      if (prevVote === voteDir) {
        delete votedBy[socket.userId];
      } else {
        votedBy[socket.userId] = voteDir;
      }

      // Recalculate total
      const totalVotes = Object.values(votedBy).reduce((sum: number, v: any) => sum + v, 0) as number;

      db.prepare('UPDATE queue_tracks SET votes = ?, voted_by = ? WHERE id = ?')
        .run(totalVotes, JSON.stringify(votedBy), trackId);

      broadcastQueue(io, sessionId);
    });

    // ─── Skip Track ──────────────────────────────────────────
    socket.on('skip-track', ({ sessionId }: { sessionId: string }) => {
      // Spotlight mode: only host can skip
      const session = db.prepare('SELECT host_id, room_mode FROM sessions WHERE id = ?').get(sessionId) as any;
      if (session?.room_mode === 'spotlight' && session.host_id !== socket.userId) {
        socket.emit('error', { message: 'Only the host can skip in Spotlight mode' });
        return;
      }
      advanceTrack(io, sessionId);
    });

    // ─── Track Ended (auto-advance from client) ─────────────
    socket.on('track-ended', ({ sessionId }: { sessionId: string }) => {
      advanceTrack(io, sessionId);
    });

    // ─── Spotlight Mode: Approve/Reject ──────────────────────
    socket.on('approve-track', ({ sessionId, trackId }: { sessionId: string; trackId: string }) => {
      db.prepare('UPDATE queue_tracks SET status = ? WHERE id = ?').run('approved', trackId);
      broadcastQueue(io, sessionId);

      const track = db.prepare('SELECT * FROM queue_tracks WHERE id = ?').get(trackId) as any;
      io.to(sessionId).emit('track-approved', { trackId, track: formatQueueTrack(track) });
    });

    socket.on('reject-track', ({ sessionId, trackId }: { sessionId: string; trackId: string }) => {
      db.prepare('DELETE FROM queue_tracks WHERE id = ?').run(trackId);
      broadcastQueue(io, sessionId);
      io.to(sessionId).emit('track-rejected', { trackId });
    });

    // ─── Change Mode ─────────────────────────────────────────
    socket.on('change-mode', ({ sessionId, roomMode }: { sessionId: string; roomMode: string }) => {
      // Only host can change mode
      const session = db.prepare('SELECT host_id FROM sessions WHERE id = ?').get(sessionId) as any;
      if (session?.host_id !== socket.userId) return;

      db.prepare('UPDATE sessions SET room_mode = ? WHERE id = ?').run(roomMode, sessionId);
      io.to(sessionId).emit('mode-changed', { sessionId, roomMode });
    });

    // ─── Reactions ───────────────────────────────────────────
    socket.on('reaction', ({ sessionId, trackId, type }: { sessionId: string; trackId: string; type: string }) => {
      io.to(sessionId).emit('reaction-received', {
        trackId,
        userId: socket.userId,
        type,
      });
    });

    // ─── Chat ────────────────────────────────────────────────
    socket.on('chat-message', ({ sessionId, text }: { sessionId: string; text: string }) => {
      const msgId = 'msg_' + uuid().slice(0, 12);
      const timestamp = new Date().toISOString();

      db.prepare(`
        INSERT INTO chat_messages (id, session_id, user_id, username, text, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(msgId, sessionId, socket.userId, socket.username, text, timestamp);

      io.to(sessionId).emit('chat-message', {
        id: msgId,
        sessionId,
        userId: socket.userId,
        username: socket.username,
        text,
        type: 'message',
        timestamp,
      });
    });

    // ─── Playback State Sync ────────────────────────────────
    socket.on('playback:state', ({ sessionId, state, position }: {
      sessionId: string; state: 'playing' | 'paused' | 'stopped'; position?: number;
    }) => {
      // Only host can control playback
      const session = db.prepare('SELECT host_id FROM sessions WHERE id = ?').get(sessionId) as any;
      if (session?.host_id !== socket.userId) return;

      const now = Date.now();
      const ps: PlaybackState = {
        state,
        position: position ?? roomPlaybackState[sessionId]?.position ?? 0,
        timestamp: now,
        trackId: roomPlaybackState[sessionId]?.trackId,
      };
      roomPlaybackState[sessionId] = ps;

      socket.to(sessionId).emit('playback:stateChange', { ...ps });
    });

    // ─── Playback Seek ───────────────────────────────────────
    socket.on('playback:seek', ({ sessionId, position }: {
      sessionId: string; position: number;
    }) => {
      const session = db.prepare('SELECT host_id FROM sessions WHERE id = ?').get(sessionId) as any;
      if (session?.host_id !== socket.userId) return;

      if (roomPlaybackState[sessionId]) {
        roomPlaybackState[sessionId].position = position;
        roomPlaybackState[sessionId].timestamp = Date.now();
      }

      socket.to(sessionId).emit('playback:seeked', { position, timestamp: Date.now() });
    });

    // ─── Latency Sync Ping ───────────────────────────────────
    // Client sends its local timestamp; server responds immediately.
    // Client calculates: roundTrip = Date.now() - clientTime
    //                    latency   = roundTrip / 2
    //                    offset    = serverTime - clientTime - latency
    socket.on('sync:ping', ({ clientTime }: { clientTime: number }, callback?: (res: any) => void) => {
      callback?.({ clientTime, serverTime: Date.now() });
    });

    // ─── Disconnect ──────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[Socket] ${socket.username} disconnected`);
    });
  });
}

// ─── Shared Helpers ───────────────────────────────────────

/**
 * Get the ordered queue for a session, respecting the room mode.
 *
 * - campfire:   Round-robin by user (user A → user B → user A → …), then position within each user.
 * - open_floor: Vote-ranked descending, position tiebreaker.
 * - spotlight:  Position order (host curates).
 */
function getOrderedQueue(sessionId: string): any[] {
  const session = db.prepare('SELECT room_mode FROM sessions WHERE id = ?').get(sessionId) as any;
  const mode = session?.room_mode || 'campfire';

  const rows = db.prepare(`
    SELECT * FROM queue_tracks
    WHERE session_id = ? AND is_current = 0 AND status = 'approved'
    ORDER BY position ASC
  `).all(sessionId) as any[];

  if (mode === 'campfire') {
    // Round-robin: interleave tracks by user in the order they were added.
    // Collect per-user queues preserving position order.
    const byUser: Record<string, any[]> = {};
    const userOrder: string[] = [];
    for (const row of rows) {
      if (!byUser[row.added_by_id]) {
        byUser[row.added_by_id] = [];
        userOrder.push(row.added_by_id);
      }
      byUser[row.added_by_id].push(row);
    }
    // Interleave: take one from each user in rotation
    const result: any[] = [];
    let round = 0;
    let added = true;
    while (added) {
      added = false;
      for (const uid of userOrder) {
        if (round < byUser[uid].length) {
          result.push(byUser[uid][round]);
          added = true;
        }
      }
      round++;
    }
    return result;
  }

  if (mode === 'openFloor' || mode === 'open_floor') {
    // Sort by votes descending, position ascending as tiebreaker
    return [...rows].sort((a, b) => b.votes - a.votes || a.position - b.position);
  }

  // spotlight: position order (host manages via approve/reject)
  return rows;
}

function broadcastQueue(io: Server, sessionId: string): void {
  const ordered = getOrderedQueue(sessionId);
  io.to(sessionId).emit('queue-updated', ordered.map(formatQueueTrack));
}

function advanceTrack(io: Server, sessionId: string): void {
  // Remove the currently-playing track from the queue entirely
  db.prepare('DELETE FROM queue_tracks WHERE session_id = ? AND is_current = 1')
    .run(sessionId);

  // Get next track using mode-aware ordering
  const ordered = getOrderedQueue(sessionId);
  const next = ordered[0] || null;

  if (next) {
    db.prepare('UPDATE queue_tracks SET is_current = 1 WHERE id = ?').run(next.id);
    const fresh = db.prepare('SELECT * FROM queue_tracks WHERE id = ?').get(next.id) as any;
    const formatted = formatQueueTrack(fresh);
    io.to(sessionId).emit('track-changed', formatted);

    // Update in-memory playback state
    roomPlaybackState[sessionId] = {
      state: 'playing',
      position: 0,
      timestamp: Date.now(),
      trackId: next.id,
    };
  } else {
    io.to(sessionId).emit('track-changed', null);
    delete roomPlaybackState[sessionId];
  }

  broadcastQueue(io, sessionId);
}
