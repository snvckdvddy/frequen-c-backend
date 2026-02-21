import { Router, Request, Response } from 'express';
import db from '../database';
import { requireAuth } from '../auth';

const router = Router();

// POST /api/auth/tidal/exchange
router.post('/exchange', requireAuth, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { code, codeVerifier, redirectUri } = req.body;

    if (!code || !redirectUri) {
        res.status(400).json({ message: 'Code and redirectUri are required' });
        return;
    }

    const clientId = 'zvU13xkVZYA7JNR2';
    const clientSecret = 'jcVLVCOxNAf7Q887oipzyloakhDVGZswdiHKKmW2wgU=';

    try {
        const params = new URLSearchParams();
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);
        params.append('grant_type', 'authorization_code');
        params.append('redirect_uri', redirectUri);
        params.append('code', code);
        if (codeVerifier) params.append('code_verifier', codeVerifier);

        const tokenRes = await fetch('https://auth.tidal.com/v1/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
            },
            body: params.toString(),
        });

        if (!tokenRes.ok) {
            const errorText = await tokenRes.text();
            res.status(tokenRes.status).json({ message: 'Failed to exchange Tidal token', details: errorText });
            return;
        }

        const tokenData = await tokenRes.json() as any;
        const { access_token, refresh_token } = tokenData;

        db.prepare(`
      UPDATE users 
      SET tidal_access_token = ?, tidal_refresh_token = ?
      WHERE id = ?
    `).run(access_token, refresh_token || null, userId);

        res.json({ message: 'Tidal connected successfully' });
    } catch (err) {
        console.error('Tidal exchange error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET /api/auth/tidal/search
router.get('/search', requireAuth, async (req, res) => {
    const q = req.query.q as string;
    const userId = (req as any).userId;

    const user = db.prepare('SELECT tidal_access_token FROM users WHERE id = ?').get(userId) as any;
    if (!user || !user.tidal_access_token) {
        res.status(401).json({ message: 'Tidal not connected' });
        return;
    }

    try {
        const tidalRes = await fetch(`https://openapi.tidal.com/search?query=${encodeURIComponent(q)}&offset=0&limit=20&type=TRACKS`, {
            headers: {
                Authorization: `Bearer ${user.tidal_access_token}`
            }
        });

        if (!tidalRes.ok) throw new Error(await tidalRes.text());

        const data = await tidalRes.json() as any;
        const tracks = data.tracks?.items?.map((t: any) => ({
            id: t.id.toString(),
            title: t.title,
            artist: t.artists?.map((a: any) => a.name).join(', ') || 'Unknown Artist',
            album: t.album?.title || '',
            albumArt: t.album?.cover ? `https://resources.tidal.com/images/${t.album.cover.replace(/-/g, '/')}/320x320.jpg` : undefined,
            previewUrl: '',
            duration: t.duration,
            source: 'tidal',
            sourceId: t.id.toString()
        })) || [];

        res.json({ tracks });

    } catch (e: any) {
        res.status(500).json({ message: e.message || 'Error fetching from Tidal' });
    }
});

// GET /api/auth/tidal/stream/:id
router.get('/stream/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const userId = (req as any).userId;

    const user = db.prepare('SELECT tidal_access_token FROM users WHERE id = ?').get(userId) as any;
    if (!user || !user.tidal_access_token) {
        res.status(401).json({ message: 'Tidal not connected' });
        return;
    }

    try {
        const streamRes = await fetch(`https://openapi.tidal.com/tracks/${id}/playbackinfopostpaywall?audioquality=HIGH&playbackmode=STREAM&assetpresentation=FULL`, {
            headers: {
                Authorization: `Bearer ${user.tidal_access_token}`
            }
        });

        if (!streamRes.ok) throw new Error(await streamRes.text());

        const streamData = await streamRes.json() as any;
        res.json({ url: streamData.url || streamData.manifest || '' });
    } catch (e: any) {
        res.status(500).json({ message: e.message || 'Error fetching stream URL from Tidal' });
    }
});

export default router;
