/**
 * Auth Routes — POST /api/auth/login, /api/auth/register, GET /api/auth/me
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import db from '../database';
import { signToken, requireAuth } from '../auth';

const router = Router();

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      res.status(400).json({ message: 'Username, email, and password are required' });
      return;
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
    if (existing) {
      res.status(409).json({ message: 'Email or username already taken' });
      return;
    }

    const id = 'usr_' + uuid().slice(0, 12);
    const passwordHash = await bcrypt.hash(password, 10);

    db.prepare(`
      INSERT INTO users (id, username, email, password_hash)
      VALUES (?, ?, ?, ?)
    `).run(id, username, email, passwordHash);

    const token = signToken({ userId: id, username });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;

    res.status(201).json({
      token,
      user: formatUser(user),
    });
  } catch (err: any) {
    console.error('Register error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ message: 'Email and password are required' });
      return;
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    if (!user) {
      res.status(401).json({ message: 'Invalid credentials' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ message: 'Invalid credentials' });
      return;
    }

    const token = signToken({ userId: user.id, username: user.username });

    res.json({
      token,
      user: formatUser(user),
    });
  } catch (err: any) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!user) {
    res.status(404).json({ message: 'User not found' });
    return;
  }
  res.json({ user: formatUser(user) });
});

function formatUser(row: any) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    avatarUrl: row.avatar_url || undefined,
    connectedServices: {},
    sessionsHosted: row.sessions_hosted,
    tracksAdded: row.tracks_added,
    totalListeningTime: row.total_listening_time,
    voltageBalance: row.voltage_balance,
    createdAt: row.created_at,
  };
}

export default router;
