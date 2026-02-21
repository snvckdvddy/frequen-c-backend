import express, { Request, Response } from 'express';
import crypto from 'crypto';
import db from '../database';
import { requireAuth } from '../auth';

const router = express.Router();

const LASTFM_API_KEY = process.env.LASTFM_API_KEY || '';
const LASTFM_SHARED_SECRET = process.env.LASTFM_SHARED_SECRET || '';

/**
 * Generate Last.fm API signature
 */
function createLastfmSignature(params: Record<string, string>): string {
    const sortedKeys = Object.keys(params)
        .filter((k) => k !== 'format' && k !== 'callback')
        .sort();
    const paramString = sortedKeys.map((k) => `${k}${params[k]}`).join('');
    const sigRaw = `${paramString}${LASTFM_SHARED_SECRET}`;
    return crypto.createHash('md5').update(sigRaw, 'utf8').digest('hex');
}

/**
 * POST /api/auth/lastfm/exchange
 * Exchanges a token from the client for a Last.fm WebService Session Key
 */
router.post('/exchange', requireAuth, async (req: Request, res: Response) => {
    const { token } = req.body;
    const userId = (req as any).user.id;

    if (!token) {
        return res.status(400).json({ message: 'Missing token' });
    }

    if (!LASTFM_API_KEY || !LASTFM_SHARED_SECRET) {
        return res.status(500).json({ message: 'Last.fm credentials not configured on backend' });
    }

    try {
        const params: Record<string, string> = {
            api_key: LASTFM_API_KEY,
            method: 'auth.getSession',
            token,
        };

        params.api_sig = createLastfmSignature(params);
        params.format = 'json';

        const queryString = new URLSearchParams(params).toString();
        const url = `http://ws.audioscrobbler.com/2.0/?${queryString}`;

        const response = await fetch(url);
        const data = await response.json() as any;

        if (!response.ok || data.error) {
            return res.status(response.status).json({ message: data.message || 'Failed to exchange Last.fm token' });
        }

        const sessionKey = data.session.key;
        const username = data.session.name;

        db.prepare(`
      UPDATE users 
      SET lastfm_session_key = ?, lastfm_username = ?
      WHERE id = ?
    `).run(sessionKey, username, userId);

        const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;

        const formattedUser = {
            id: userRow.id,
            username: userRow.username,
            email: userRow.email,
            avatarUrl: userRow.avatar_url,
            sessionsHosted: userRow.sessions_hosted || 0,
            tracksAdded: userRow.tracks_added || 0,
            totalListeningTime: userRow.total_listening_time || 0,
            voltageBalance: userRow.cv_balance || 100,
            connectedServices: {
                spotify: {
                    connected: !!userRow.spotify_access_token,
                    username: userRow.spotify_username,
                },
                soundcloud: {
                    connected: !!userRow.soundcloud_access_token,
                },
                tidal: {
                    connected: !!userRow.tidal_access_token,
                },
                lastfm: {
                    connected: !!userRow.lastfm_session_key,
                    username: userRow.lastfm_username,
                }
            },
        };

        return res.json({ message: 'Last.fm connected successfully', user: formattedUser });

    } catch (error) {
        console.error('Last.fm token exchange error:', error);
        return res.status(500).json({ message: 'Internal server error during Last.fm integration' });
    }
});

export default router;
