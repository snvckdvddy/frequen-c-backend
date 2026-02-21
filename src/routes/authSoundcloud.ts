import { Router } from 'express';
import db from '../database';

const router = Router();

// 1. GET /api/auth/soundcloud/callback
router.get('/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        console.error('Soundcloud Auth Error:', error);
        res.redirect('frequenc://auth-error?service=soundcloud');
        return;
    }

    if (!code || !state) {
        res.status(400).send('Missing code or state');
        return;
    }

    const userId = state as string;
    const clientId = 'A6P1OlzNLYo7LrMcTA2TaGWVzM6RHgbw';
    const clientSecret = 'CtC4AzYKu9qUwOvzGLOoAD2ngOsDYBma';
    const redirectUri = 'http://localhost:5000/api/auth/soundcloud/callback';

    try {
        const params = new URLSearchParams();
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);
        params.append('grant_type', 'authorization_code');
        params.append('redirect_uri', redirectUri);
        params.append('code', code as string);

        const tokenRes = await fetch('https://api.soundcloud.com/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
        });

        if (!tokenRes.ok) {
            const errorText = await tokenRes.text();
            console.error('Failed to exchange SC token:', errorText);
            res.redirect('frequenc://auth-error?service=soundcloud');
            return;
        }

        const tokenData = (await tokenRes.json()) as any;
        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;

        db.prepare(`
      UPDATE users 
      SET soundcloud_access_token = ?, soundcloud_refresh_token = ?
      WHERE id = ?
    `).run(accessToken, refreshToken, userId);

        res.redirect('frequenc://auth-success?service=soundcloud');
    } catch (err) {
        console.error('SoundCloud callback error:', err);
        res.status(500).send('Internal Server Error');
    }
});

// 2. GET /api/auth/soundcloud/search
router.get('/search', async (req, res) => {
    const q = req.query.q as string;
    const userId = (req as any).userId;

    if (!q) {
        res.status(400).json({ message: 'Missing q parameter' });
        return;
    }

    const user = db.prepare('SELECT soundcloud_access_token FROM users WHERE id = ?').get(userId) as any;
    if (!user || !user.soundcloud_access_token) {
        res.status(401).json({ message: 'SoundCloud not connected' });
        return;
    }

    try {
        const scRes = await fetch(`https://api.soundcloud.com/tracks?q=${encodeURIComponent(q)}&limit=20`, {
            headers: {
                Authorization: `OAuth ${user.soundcloud_access_token}`
            }
        });

        if (!scRes.ok) throw new Error(await scRes.text());

        const data = await scRes.json() as any[];

        const tracks = data.map((t: any) => ({
            id: t.id.toString(),
            title: t.title,
            artist: t.user?.username || 'Unknown Artist',
            album: '',
            albumArt: t.artwork_url || t.user?.avatar_url,
            previewUrl: t.stream_url,
            duration: Math.floor(t.duration / 1000),
            source: 'soundcloud',
            sourceId: t.id.toString()
        }));

        res.json({ tracks });

    } catch (e: any) {
        res.status(500).json({ message: e.message || 'Error fetching from SoundCloud' });
    }
});

// 3. GET /api/auth/soundcloud/stream/:id
router.get('/stream/:id', async (req, res) => {
    const { id } = req.params;
    const userId = (req as any).userId;

    const user = db.prepare('SELECT soundcloud_access_token FROM users WHERE id = ?').get(userId) as any;
    if (!user || !user.soundcloud_access_token) {
        res.status(401).json({ message: 'SoundCloud not connected' });
        return;
    }

    const streamUrl = `https://api.soundcloud.com/tracks/${id}/stream?oauth_token=${user.soundcloud_access_token}`;
    res.json({ url: streamUrl });
});

export default router;
