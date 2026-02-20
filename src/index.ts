/**
 * Frequen-C Backend — Express + Socket.io + SQLite
 *
 * Serves the REST API and WebSocket events for the mobile app.
 *
 * Usage:
 *   npm run dev    — development with auto-reload
 *   npm run build  — compile TypeScript
 *   npm start      — production
 */

import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import authRoutes from './routes/authRoutes';
import sessionRoutes from './routes/sessionRoutes';
import { setupSocketHandlers } from './socketHandler';

const PORT = parseInt(process.env.PORT || '5000', 10);

// ─── Express Setup ──────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionRoutes);

// Search routes (sessions search is on session router, users search here)
app.get('/api/search/sessions', (req, res) => {
  // Forward to session route handler
  req.url = `/search/sessions?q=${req.query.q || ''}`;
  sessionRoutes(req, res, () => {});
});

app.get('/api/search/users', (req, res) => {
  // Simple user search
  const db = require('./database').default;
  const q = ((req.query.q as string) || '').toLowerCase();
  const rows = db.prepare(`
    SELECT id, username, avatar_url, sessions_hosted as sessionsCount, tracks_added as tracksAdded
    FROM users
    WHERE LOWER(username) LIKE ?
    LIMIT 20
  `).all(`%${q}%`) as any[];

  res.json({
    users: rows.map((r: any) => ({
      id: r.id,
      username: r.username,
      avatarUrl: r.avatar_url || undefined,
      sessionsCount: r.sessionsCount,
      tracksAdded: r.tracksAdded,
    })),
  });
});

// ─── HTTP + Socket.io Server ─────────────────────────────────────────────────

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

setupSocketHandlers(io);

// ─── Start ──────────────────────────────────────────────────────────────────

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ╜════════════════════════════════════╞`);
  console.log(`  ║  Frequen-C Backend running on :${PORT}  ║`);
  console.log(`  ╚════════════════════════════════════╝\n`);
  console.log(`  REST API:  http://localhost:${PORT}/api`);
  console.log(`  Socket.io: ws://localhost:${PORT}`);
  console.log(`  Health:    http://localhost:${PORT}/api/health\n`);
});

export { app, httpServer, io };
