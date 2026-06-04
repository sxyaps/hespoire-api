const express = require('express');
const cors = require('cors');
const { META, MOVIES } = require('@consumet/extensions');

const app = express();
app.use(cors());
app.use(express.json());

const TMDB_KEY = process.env.TMDB_KEY || '06e955fa0b338a170d7b8dc9710016b0';

// Try each provider until one works
const providers = [
    () => new META.TMDB(new MOVIES.FlixHQ(), TMDB_KEY),
    () => new META.TMDB(new MOVIES.SFlix(), TMDB_KEY),
    () => new META.TMDB(new MOVIES.Goku(), TMDB_KEY),
    () => new META.TMDB(undefined, TMDB_KEY),
];

function getProvider(index = 0) {
    try { return providers[index](); }
    catch(e) { return index + 1 < providers.length ? getProvider(index + 1) : null; }
}

// GET /meta/tmdb/info/:id?type=movie|tv
app.get('/meta/tmdb/info/:id', async (req, res) => {
    const type = req.query.type === 'tv' ? 'TV Series' : 'Movie';
    // Try providers in order until one succeeds
    const errors = [];
    for (let i = 0; i < providers.length; i++) {
        try {
            const p = providers[i]();
            if (!p) continue;
            const data = await p.fetchMediaInfo(req.params.id, type);
            if (data) return res.json(data);
        } catch (e) {
            errors.push(`Provider ${i}: ${e.message}`);
        }
    }
    res.status(500).json({ message: 'All providers failed', errors });
});

// GET /meta/tmdb/watch/:episodeId?id=tmdb-xxxxx
app.get('/meta/tmdb/watch/:episodeId', async (req, res) => {
    const episodeId = decodeURIComponent(req.params.episodeId);
    const mediaId = decodeURIComponent(req.query.id || '');
    for (const makeProvider of providers) {
        try {
            const p = makeProvider();
            if (!p) continue;
            const data = await p.fetchEpisodeSources(episodeId, mediaId);
            if (data && data.sources && data.sources.length) return res.json(data);
        } catch (e) {
            console.error(`Provider failed: ${e.message}`);
        }
    }
    res.status(500).json({ message: 'No sources found from any provider' });
});

app.get('/', (_, res) => res.json({ status: 'ok' }));

app.get('/debug2', (_, res) => {
    const { TvType } = require('@consumet/extensions');
    res.json({ TvType });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stream API running on port ${PORT}`));
