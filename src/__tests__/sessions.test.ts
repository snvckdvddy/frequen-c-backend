/**
 * Session Routes — Integration Tests
 *
 * Coverage:
 *   POST   /api/sessions          — Create a room
 *   GET    /api/sessions          — List public rooms
 *   GET    /api/sessions/mine     — User's rooms
 *   GET    /api/sessions/discover — Discovery feed
 *   GET    /api/sessions/:id      — Get one room
 *   POST   /api/sessions/join     — Join by code
 *   POST   /api/sessions/:id/end  — End session (host only)
 */

import path from 'path';

process.env.NODE_ENV = 'test';
const TEST_DB_PATH = path.join('/tmp', `frequenc_sessions_test_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;

import fs from 'fs';
import request from 'supertest';
import { app } from '../index';

// ─── Setup ──────────────────────────────────────────────────

const HOST_USER = { username: 'host_user', email: 'host@frequenc.app', password: 'hostPass123' };
const GUEST_USER = { username: 'guest_user', email: 'guest@frequenc.app', password: 'guestPass123' };

let hostToken = '';
let hostUserId = '';
let guestToken = '';
let sessionId = '';
let joinCode = '';

beforeAll(async () => {
  const hostRes = await request(app).post('/api/auth/register').send(HOST_USER);
  hostToken = hostRes.body.token;
  hostUserId = hostRes.body.user.id;

  const guestRes = await request(app).post('/api/auth/register').send(GUEST_USER);
  guestToken = guestRes.body.token;
});

afterAll(() => {
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
    if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
  } catch { /* ignore */ }
});

// ─── POST /api/sessions ─────────────────────────────────────

describe('POST /api/sessions', () => {
  it('creates a public campfire room', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${hostToken}`)
      .send({ name: 'Test Room', genre: 'Lo-fi', roomMode: 'campfire', isPublic: true })
      .expect(201);

    expect(res.body.session).toBeDefined();
    expect(res.body.session.name).toBe('Test Room');
    expect(res.body.session.genre).toBe('Lo-fi');
    expect(res.body.session.roomMode).toBe('campfire');
    expect(res.body.session.isPublic).toBe(true);
    expect(res.body.session.isLive).toBe(true);
    expect(res.body.session.joinCode).toHaveLength(6);
    expect(res.body.session.hostId).toBe(hostUserId);
    expect(res.body.session.listeners).toHaveLength(1);

    sessionId = res.body.session.id;
    joinCode = res.body.session.joinCode;
  });

  it('defaults to campfire / Mixed if omitted', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${hostToken}`)
      .send({ name: 'Minimal Room' })
      .expect(201);

    expect(res.body.session.roomMode).toBe('campfire');
    expect(res.body.session.genre).toBe('Mixed');
  });

  it('rejects missing name with 400', async () => {
    await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${hostToken}`)
      .send({ genre: 'Pop' })
      .expect(400);
  });

  it('rejects unauthenticated requests', async () => {
    await request(app)
      .post('/api/sessions')
      .send({ name: 'No Auth Room' })
      .expect(401);
  });
});

// ─── GET /api/sessions ──────────────────────────────────────

describe('GET /api/sessions', () => {
  it('returns public live sessions', async () => {
    const res = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${hostToken}`)
      .expect(200);

    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions.length).toBeGreaterThanOrEqual(1);

    const found = res.body.sessions.find((s: any) => s.id === sessionId);
    expect(found).toBeDefined();
    expect(found.name).toBe('Test Room');
  });
});

// ─── GET /api/sessions/mine ─────────────────────────────────

describe('GET /api/sessions/mine', () => {
  it('returns rooms the user is in', async () => {
    const res = await request(app)
      .get('/api/sessions/mine')
      .set('Authorization', `Bearer ${hostToken}`)
      .expect(200);

    expect(res.body.sessions.length).toBeGreaterThanOrEqual(1);
    const found = res.body.sessions.find((s: any) => s.id === sessionId);
    expect(found).toBeDefined();
  });

  it('guest has no rooms yet', async () => {
    const res = await request(app)
      .get('/api/sessions/mine')
      .set('Authorization', `Bearer ${guestToken}`)
      .expect(200);

    expect(res.body.sessions).toHaveLength(0);
  });
});

// ─── GET /api/sessions/discover ─────────────────────────────

describe('GET /api/sessions/discover', () => {
  it('returns discovery feed', async () => {
    const res = await request(app)
      .get('/api/sessions/discover')
      .set('Authorization', `Bearer ${hostToken}`)
      .expect(200);

    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── GET /api/sessions/:id ──────────────────────────────────

describe('GET /api/sessions/:id', () => {
  it('returns a specific session', async () => {
    const res = await request(app)
      .get(`/api/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${hostToken}`)
      .expect(200);

    expect(res.body.session.id).toBe(sessionId);
    expect(res.body.session.joinCode).toBeDefined();
    expect(res.body.session.queue).toBeDefined();
  });

  it('returns 404 for nonexistent session', async () => {
    await request(app)
      .get('/api/sessions/ses_nonexistent')
      .set('Authorization', `Bearer ${hostToken}`)
      .expect(404);
  });
});

// ─── POST /api/sessions/join ────────────────────────────────

describe('POST /api/sessions/join', () => {
  it('joins a room by code', async () => {
    const res = await request(app)
      .post('/api/sessions/join')
      .set('Authorization', `Bearer ${guestToken}`)
      .send({ joinCode })
      .expect(200);

    expect(res.body.session.id).toBe(sessionId);
    const listenerUsernames = res.body.session.listeners.map((l: any) => l.username);
    expect(listenerUsernames).toContain('guest_user');
  });

  it('guest now sees room in /mine', async () => {
    const res = await request(app)
      .get('/api/sessions/mine')
      .set('Authorization', `Bearer ${guestToken}`)
      .expect(200);

    const found = res.body.sessions.find((s: any) => s.id === sessionId);
    expect(found).toBeDefined();
  });

  it('case-insensitive join code', async () => {
    const res = await request(app)
      .post('/api/sessions/join')
      .set('Authorization', `Bearer ${guestToken}`)
      .send({ joinCode: joinCode.toLowerCase() })
      .expect(200);

    expect(res.body.session.id).toBe(sessionId);
  });

  it('rejects missing join code with 400', async () => {
    await request(app)
      .post('/api/sessions/join')
      .set('Authorization', `Bearer ${guestToken}`)
      .send({})
      .expect(400);
  });

  it('rejects invalid join code with 404', async () => {
    await request(app)
      .post('/api/sessions/join')
      .set('Authorization', `Bearer ${guestToken}`)
      .send({ joinCode: 'XXXXXX' })
      .expect(404);
  });
});

// ─── POST /api/sessions/:id/end ─────────────────────────────

describe('POST /api/sessions/:id/end', () => {
  it('rejects non-host ending session with 403', async () => {
    await request(app)
      .post(`/api/sessions/${sessionId}/end`)
      .set('Authorization', `Bearer ${guestToken}`)
      .expect(403);
  });

  it('host can end the session', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/end`)
      .set('Authorization', `Bearer ${hostToken}`)
      .expect(200);

    expect(res.body.message).toMatch(/ended/i);
  });

  it('ended session no longer appears in public list', async () => {
    const res = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${hostToken}`)
      .expect(200);

    const found = res.body.sessions.find((s: any) => s.id === sessionId);
    expect(found).toBeUndefined();
  });

  it('returns 404 for nonexistent session', async () => {
    await request(app)
      .post('/api/sessions/ses_nonexistent/end')
      .set('Authorization', `Bearer ${hostToken}`)
      .expect(404);
  });
});
