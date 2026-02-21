/**
 * Auth Routes — Integration Tests
 *
 * Tests the full HTTP request → response cycle for all auth endpoints.
 * Uses a temporary SQLite DB (deleted after each suite) for isolation.
 *
 * Coverage:
 *   POST /api/auth/register
 *   POST /api/auth/login
 *   GET  /api/auth/me
 *   POST /api/auth/refresh
 *   POST /api/auth/push-token
 *   GET  /api/auth/noise-gate
 *   PUT  /api/auth/noise-gate
 *   DELETE /api/auth/account
 */

import path from 'path';
import fs from 'fs';

// Set env vars before any app imports so modules initialise correctly.
process.env.NODE_ENV = 'test';
const TEST_DB_PATH = path.join('/tmp', `frequenc_test_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;

import request from 'supertest';
import { app } from '../index';

// ─── Helpers ──────────────────────────────────────────────────

const TEST_USER = {
  username: 'testuser',
  email: 'test@frequenc.app',
  password: 'securePass123',
};

const TEST_USER_2 = {
  username: 'alice',
  email: 'alice@frequenc.app',
  password: 'alicePass456',
};

let authToken = '';
let userId = '';

// ─── Cleanup ─────────────────────────────────────────────────

afterAll(() => {
  // Remove the temp DB file
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
    if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
  } catch { /* ignore cleanup errors */ }
});

// ─── POST /api/auth/register ─────────────────────────────────

describe('POST /api/auth/register', () => {
  it('creates a new user and returns token + user object', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send(TEST_USER)
      .expect(201);

    expect(res.body.token).toBeDefined();
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user).toBeDefined();
    expect(res.body.user.username).toBe(TEST_USER.username);
    expect(res.body.user.email).toBe(TEST_USER.email);
    expect(res.body.user.id).toMatch(/^usr_/);
    expect(res.body.user.noiseGate).toBe('medium'); // default

    // Stash for later tests
    authToken = res.body.token;
    userId = res.body.user.id;
  });

  it('rejects duplicate email/username with 409', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send(TEST_USER)
      .expect(409);

    expect(res.body.message).toMatch(/already taken/i);
  });

  it('rejects missing fields with 400', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'nopass', email: 'no@pass.com' })
      .expect(400);
  });

  it('rejects missing username with 400', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'x@x.com', password: 'abc123' })
      .expect(400);
  });
});

// ─── POST /api/auth/login ────────────────────────────────────

describe('POST /api/auth/login', () => {
  it('authenticates with correct credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_USER.email, password: TEST_USER.password })
      .expect(200);

    expect(res.body.token).toBeDefined();
    expect(res.body.user.username).toBe(TEST_USER.username);
  });

  it('rejects wrong password with 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_USER.email, password: 'wrongpassword' })
      .expect(401);

    expect(res.body.message).toMatch(/invalid credentials/i);
  });

  it('rejects nonexistent email with 401', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'nonexistent@test.com', password: 'abc' })
      .expect(401);
  });

  it('rejects missing fields with 400', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_USER.email })
      .expect(400);
  });
});

// ─── GET /api/auth/me ────────────────────────────────────────

describe('GET /api/auth/me', () => {
  it('returns the authenticated user profile', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.user.id).toBe(userId);
    expect(res.body.user.username).toBe(TEST_USER.username);
    expect(res.body.user.email).toBe(TEST_USER.email);
    expect(res.body.user.voltageBalance).toBeDefined();
    expect(res.body.user.sessionsHosted).toBeDefined();
  });

  it('rejects unauthenticated requests with 401', async () => {
    await request(app)
      .get('/api/auth/me')
      .expect(401);
  });

  it('rejects invalid token with 401', async () => {
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalidtoken123')
      .expect(401);
  });
});

// ─── POST /api/auth/refresh ──────────────────────────────────

describe('POST /api/auth/refresh', () => {
  it('issues a fresh token', async () => {
    await new Promise((r) => setTimeout(r, 1100));

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.token).toBeDefined();
    expect(res.body.token).not.toBe(authToken);

    authToken = res.body.token;
  });

  it('rejects unauthenticated requests', async () => {
    await request(app)
      .post('/api/auth/refresh')
      .expect(401);
  });
});

// ─── POST /api/auth/push-token ───────────────────────────────

describe('POST /api/auth/push-token', () => {
  it('saves a push token', async () => {
    const res = await request(app)
      .post('/api/auth/push-token')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ pushToken: 'ExponentPushToken[abc123xyz]' })
      .expect(200);

    expect(res.body.message).toMatch(/saved/i);
  });

  it('rejects missing pushToken with 400', async () => {
    await request(app)
      .post('/api/auth/push-token')
      .set('Authorization', `Bearer ${authToken}`)
      .send({})
      .expect(400);
  });

  it('rejects unauthenticated requests', async () => {
    await request(app)
      .post('/api/auth/push-token')
      .send({ pushToken: 'ExponentPushToken[abc]' })
      .expect(401);
  });
});

// ─── GET /api/auth/noise-gate ────────────────────────────────

describe('GET /api/auth/noise-gate', () => {
  it('returns default noise gate (medium)', async () => {
    const res = await request(app)
      .get('/api/auth/noise-gate')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.noiseGate).toBe('medium');
  });
});

// ─── PUT /api/auth/noise-gate ────────────────────────────────

describe('PUT /api/auth/noise-gate', () => {
  it('updates noise gate to high', async () => {
    const res = await request(app)
      .put('/api/auth/noise-gate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ noiseGate: 'high' })
      .expect(200);

    expect(res.body.noiseGate).toBe('high');
  });

  it('persists the change (verify via GET)', async () => {
    const res = await request(app)
      .get('/api/auth/noise-gate')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.noiseGate).toBe('high');
  });

  it('updates to off', async () => {
    const res = await request(app)
      .put('/api/auth/noise-gate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ noiseGate: 'off' })
      .expect(200);

    expect(res.body.noiseGate).toBe('off');
  });

  it('rejects invalid noise gate value with 400', async () => {
    await request(app)
      .put('/api/auth/noise-gate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ noiseGate: 'max' })
      .expect(400);
  });

  it('rejects missing noiseGate with 400', async () => {
    await request(app)
      .put('/api/auth/noise-gate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({})
      .expect(400);
  });
});

// ─── DELETE /api/auth/account ─────────────────────────────────

describe('DELETE /api/auth/account', () => {
  let user2Token = '';

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send(TEST_USER_2);

    user2Token = res.body.token;
  });

  it('deletes the account and returns success', async () => {
    const res = await request(app)
      .delete('/api/auth/account')
      .set('Authorization', `Bearer ${user2Token}`)
      .expect(200);

    expect(res.body.message).toMatch(/deleted/i);
  });

  it('deleted user cannot authenticate with /me', async () => {
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${user2Token}`)
      .expect(404);
  });

  it('deleted user cannot login', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_USER_2.email, password: TEST_USER_2.password })
      .expect(401);
  });
});

// ─── Health Check (sanity) ───────────────────────────────────

describe('GET /api/health', () => {
  it('returns OK', async () => {
    const res = await request(app)
      .get('/api/health')
      .expect(200);

    expect(res.body.status).toBe('ok');
  });
});
