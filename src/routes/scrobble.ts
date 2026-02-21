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
    const sortedKeys = Object.keys(params).sort();
    const paramString = sortedKeys.map((k) => `${k}${params[k]}`).join('');
    const sigRaw = `${paramString}${LASTFM_SHARED_SECRET}`;
    return crypto.createHash('md5').update(sigRaw, 'utf8').digest('hex');
}

/**
 * POST /api/scrobble
 * Submit a track scrobble to Last.fm for the authenticated user.
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
    const { track, artist, timestamp } = req.body;
    const userId = (req as any).user.id;

    if (!track || !artist || !timestamp) {
        return res.status(400).json({ message: 'Missing track, artist, or timestamp parameters' });
    }

    if (!LASTFM_API_KEY || !LASTFM_SHARED_SECRET) {
        return res.status(500).json({ message: 'Last.fm credentials not configured' });
    }

    try {
        const userRow = db.prepare('SELECT lastfm_session_key FROM users WHERE id = ?').get(userId) as any;
        if (!userRow || !userRow.lastfm_session_key) {
            return res.status(403).json({ message: 'User not connected to Last.fm' });
        }

        const sessionKey = userRow.lastfm_session_key;

        const params: Record<string, string> = {
            api_key: LASTFM_API_KEY,
            method: 'track.scrobble',
            artist,
            track,
            timestamp: timestamp.toString(),
            sk: sessionKey,
        };

        params.api_sig = createLastfmSignature(params);
        params.format = 'json';

        const formBody = new URLSearchParams(params);

        const response = await fetch('http://ws.audioscrobbler.com/2.0/', {
            method: 'POST',
            body: formBody,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        const data = await response.json() as any;

        if (!response.ok || data.error) {
            return res.status(response.status).json({ message: data.message || 'Failed to scrobble track' });
        }

        return res.json({ message: 'Track scrobbled successfully', data: data.scrobbles });
    } catch (error) {
        console.error('Last.fm scrobbling error:', error);
        return res.status(500).json({ message: 'Internal server error during scrobbling' });
    }
});

export default router;
