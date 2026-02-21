import express, { Request, Response } from 'express';
import { Client } from 'genius-lyrics';
import { requireAuth } from '../auth';

const router = express.Router();
const genius = new Client(process.env.GENIUS_CLIENT_ACCESS_TOKEN || '');

/**
 * GET /api/lyrics/search
 * Fetches lyrics for a given track title and artist.
 */
router.get('/search', requireAuth, async (req: Request, res: Response) => {
    const title = req.query.title as string;
    const artist = req.query.artist as string;

    if (!title || !artist) {
        return res.status(400).json({ message: 'Missing title or artist query parameters' });
    }

    try {
        const searches = await genius.songs.search(`${title} ${artist}`);

        if (!searches || searches.length === 0) {
            return res.status(404).json({ message: 'Lyrics not found' });
        }

        const song = searches[0];
        const lyrics = await song.lyrics();

        if (!lyrics) {
            return res.status(404).json({ message: 'Lyrics text not available' });
        }

        return res.json({
            title: song.title,
            artist: song.artist.name,
            lyrics,
            url: song.url,
            thumbnail: song.thumbnail,
        });
    } catch (error) {
        console.error('Genius lyrics error:', error);
        return res.status(500).json({ message: 'Failed to fetch lyrics' });
    }
});

export default router;
