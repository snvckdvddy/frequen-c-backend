/**
 * SQLite Database Layer
 *
 * Single-file DB for the Frequen-C backend.
 * Tables: users, sessions, session_listeners, queue_tracks, chat_messages
 */

import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';

// Default: project root. Override via DB_PATH env var for environments
// where the project dir isn't writable (e.g., mounted volumes).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'frequenc.db');

const db: DatabaseType = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ──────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url TEXT,
    sessions_hosted INTEGER DEFAULT 0,
    tracks_added INTEGER DEFAULT 0,
    total_listening_time INTEGER DEFAULT 0,
    voltage_balance INTEGER DEFAULT 100,
    push_token TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host_id TEXT NOT NULL REFERENCES users(id),
    description TEXT DEFAULT '',
    genre TEXT DEFAULT 'Mixed',
    room_mode TEXT DEFAULT 'campfire',
    is_public INTEGER DEFAULT 1,
    is_live INTEGER DEFAULT 1,
    join_code TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS session_listeners (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS queue_tracks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT,
    album_art TEXT,
    preview_url TEXT,
    duration INTEGER DEFAULT 30,
    source TEXT DEFAULT 'itunes',
    source_id TEXT,
    added_by_id TEXT NOT NULL REFERENCES users(id),
    added_by_username TEXT NOT NULL,
    votes INTEGER DEFAULT 0,
    voted_by TEXT DEFAULT '{}',
    status TEXT DEFAULT 'approved',
    position INTEGER DEFAULT 0,
    is_current INTEGER DEFAULT 0,
    added_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    type TEXT DEFAULT 'message',
    timestamp TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_queue_session ON queue_tracks(session_id, position);
  CREATE INDEX IF NOT EXISTS idx_listeners_session ON session_listeners(session_id);
  CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id, timestamp);
`);

export default db;
