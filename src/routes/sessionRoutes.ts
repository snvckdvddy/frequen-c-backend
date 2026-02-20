/**
 * Session Routes — CRUD for listening rooms
 *
 * POST   /api/sessions         — Create
 * GET    /api/sessions          — List all public
 * GET    /api/sessions/mine     — User's rooms
 * GET    /api/sessions/discover — Discovery feed
 * GET    /api/sessions/:id      — Get one
 * POST   /api/sessions/join     — Join by code
 */

import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../database';
import { requireAuth } from '../auth';

const router = Router();

router.use(requireAuth);

router.post('/', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const username = (req as any).username;
  const { name, genre, roomMode, isPublic } = req.body;

  if (!name) {
    res.status(400).json({ message: 'Room name is required' });
    return;
  }

  const id = 'ses_' + uuid().slice(0, 12);
  const joinCode = generateJoinCode();

  db.prepare(`
    INSERT INTO sessions (id, name, host_id, genre, room_mode, is_public, join_code)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, userId, genre || 'Mixed', roomMode || 'campfire', isPublic !== false ? 1 : 0, joinCode);

  db.prepare('INSERT INTO session_listeners (session_id, user_id) VALUES (?, ?)').run(id, userId);
  db.prepare('UPDATE users SET sessions_hosted = sessions_hosted + 1 WHERE id = ?').run(userId);

  const session = getSessionById(id, username);
  res.status(201).json({ session });
});

router.get('/', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT s.*, u.username as host_username
    FROM sessions s
    JOIN users u ON s.host_id = u.id
    WHERE s.is_public = 1 AND s.is_live = 1
    ORDER BY s.created_at DESC
  `).all() as any[];

  const sessions = rows.map((r) => formatSession(r));
  res.json({ sessions });
});

router.get('/mine', (req: Request, res: Response) => {
  const userId = (req as any).userId;

  const rows = db.prepare(`
    SELECT s.*, u.username as host_username
    FROM sessions s
    JOIN users u ON s.host_id = u.id
    JOIN session_listeners sl ON sl.session_id = s.id
    WHERE sl.user_id = ? AND s.is_live = 1
    ORDER BY s.created_at DESC
  `).all(userId) as any[];

  const sessions = rows.map((r) => formatSession(r));
  res.json({ sessions });
});

router.get('/discover', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT s.*, u.username as host_username
    FROM sessions s
    JOIN users u ON s.host_id = u.id
    WHERE s.is_public = 1 AND s.is_live = 1
    ORDER BY s.created_at DESC
  `).all() as any[];

  const sessions = rows.map((r) => formatSession(r));
  res.json({ sessions });
});

router.get('/:id', (req: Request, res: Response) => {
  const username = (req as any).username;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const session = getSessionById(id, username);
  if (!session) {
    res.status(404).json({ message: 'Session not found' });
    return;
  }
  res.json({ session });
});

router.post('/join', (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const username = (req as any).username;
  const { joinCode } = req.body;

  if (!joinCode) {
    res.status(400).json({ message: 'Join code is required' });
    return;
  }

  const row = db.prepare(`
    SELECT s.*, u.username as host_username
    FROM sessions s
    JOIN users u ON s.host_id = u.id
    WHERE UPPER(s.join_code) = UPPER(?)
  `).get(joinCode) as any;

  if (!row) {
    res.status(404).json({ message: 'No room found with that code' });
    return;
  }

  db.prepare(`
    INSERT OR IGNORE INTO session_listeners (session_id, user_id) VALUES (?, ?)
  `).run(row.id, userId);

  const session = getSessionById(row.id, username);
  res.json({ session });
});

router.get('/search/sessions', (req: Request, res: Response) => {
  const q = (req.query.q as string || '').toLowerCase();
  const rows = db.prepare(`
    SELECT s.*, u.username as host_username
    FROM sessions s
    JOIN users u ON s.host_id = u.id
    WHERE s.is_public = 1 AND s.is_live = 1
      AND (LOWER(s.name) LIKE ? OR LOWER(s.genre) LIKE ? OR LOWER(u.username) LIKE ?)
    ORDER BY s.created_at DESC
    LIMIT 20
  `).all(`%${q}%`, `%${q}%`, `%${q}%`) as any[];

  res.json({ sessions: rows.map(formatSession) });
});

function generateJoinCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getSessionById(id: string, _username?: string) {
  const row = db.prepare(`
    SELECT s.*, u.username as host_username
    FROM sessions s
    JOIN users u ON s.host_id = u.id
    WHERE s.id = ?
  `).get(id) as any;

  if (!row) return null;
  return formatSession(row);
}

function formatSession(row: any) {
  const listeners = db.prepare(`
    SELECT u.id as userId, u.username, u.avatar_url as avatarUrl
    FROM session_listeners sl
    JOIN users u ON sl.user_id = u.id
    WHERE sl.session_id = ?
  `).all(row.id) as any[];

  const queueRows = db.prepare(`
    SELECT * FROM queue_tracks
    WHERE session_id = ? AND is_current = 0
    ORDER BY position ASC
  `).all(row.id) as any[];

  const currentTrackRow = db.prepare(`
    SELECT * FROM queue_tracks
    WHERE session_id = ? AND is_current = 1
    LIMIT 1
  `).get(row.id) as any;

  return {
    id: row.id,
    name: row.name,
    hostId: row.host_id,
    hostUsername: row.host_username,
    description: row.description || '',
    genre: row.genre,
    roomMode: row.room_mode,
    isPublic: row.is_public === 1,
    isLive: row.is_live === 1,
    joinCode: row.join_code,
    listeners: listeners.map((l: any) => ({
      userId: l.userId,
      username: l.username,
      avatarUrl: l.avatarUrl || undefined,
    })),
    currentTrack: currentTrackRow ? formatQueueTrack(currentTrackRow) : undefined,
    queue: queueRows.map(formatQueueTrack),
    createdAt: row.created_at,
  };
}

function formatQueueTrack(row: any) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album || undefined,
    albumArt: row.album_art || undefined,
    previewUrl: row.preview_url || undefined,
    duration: row.duration,
    source: row.source,
    sourceId: row.source_id || undefined,
    addedBy: { userId: row.added_by_id, username: row.added_by_username },
    addedById: row.added_by_id,
    addedAt: row.added_at,
    votes: row.votes,
    votedBy: JSON.parse(row.voted_by || '{}'),
    status: row.status,
  };
}

export default router;
export { formatQueueTrack };
