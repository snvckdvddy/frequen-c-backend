/**
 * Search & Misc Routes — Integration Tests
 *
 * Coverage:
 *   GET /api/search/users      — Search users by username
 *   GET /api/search/sessions   — Search public sessions
 *   GET /api/health            — Health check
 */

import path from 'path';

process.env.NODE_ENV = 'test';
const TEST_DB_PATH = path.join('/tmp', `frequenc_search_test_${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;

import fs from 'fs';
import request from 'supertest';
import { app } from '../index';

// ─── Setup ──────────────────────────────────────────────────

let token = '';

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: 'searchAlpha', email: 'alpha@test.com', password: 'pass123' });
  token = res.body.token;

  await request(app)
    .post('/api/auth/register')
    .send({ username: 'searchBeta', email: 'beta@test.com', password: 'pass123' });

  await request(app)
    .post('/api/auth/register')
    .send({ username: 'totallyDifferent', email: 'diff@test.com', password: 'pass123' });

  await request(app)
    .post('/api/sessions')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Lo-fi Chill Room', genre: 'Lo-fi', roomMode: 'campfire', isPublic: true });
});

afterAll(() => {
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
    if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
  } catch { /* ignore */ }
});

// ─── GET /api/search/users ──────────────────────────────────

describe('GET /api/search/users', () => {
  it('finds users by partial username', async () => {
    const res = await request(app)
      .get('/api/search/users?q=search')
      .expect(200);

    expect(res.body.users.length).toBe(2);
    const names = res.body.users.map((u: any) => u.username);
    expect(names).toContain('searchAlpha');
    expect(names).toContain('searchBeta');
  });

  it('is case-insensitive', async () => {
    const res = await request(app)
      .get('/api/search/users?q=SEARCH')
      .expect(200);

    expect(res.body.users.length).toBe(2);
  });

  it('returns empty for no matches', async () => {
    const res = await request(app)
      .get('/api/search/users?q=zzzznonexistent')
      .expect(200);

    expect(res.body.users).toHaveLength(0);
  });

  it('returns user shape with expected fields', async () => {
    const res = await request(app)
      .get('/api/search/users?q=alpha')
      .expect(200);

    const user = res.body.users[0];
    expect(user.id).toBeDefined();
    expect(user.username).toBe('searchAlpha');
    expect(user.sessionsCount).toBeDefined();
    expect(user.tracksAdded).toBeDefined();
  });
});

// ─── GET /api/search/sessions ───────────────────────────────

describe('GET /api/search/sessions', () => {
  it('finds sessions by name', async () => {
    const res = await request(app)
      .get('/api/search/sessions?q=lo-fi')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.sessions.length).toBeGreaterThanOrEqual(1);
    expect(res.body.sessions[0].name).toMatch(/lo-fi/i);
  });

  it('returns empty for no matches', async () => {
    const res = await request(app)
      .get('/api/search/sessions?q=zzzznonexistent')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.sessions).toHaveLength(0);
  });
});
