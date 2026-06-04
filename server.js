const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const TMDB_KEY = process.env.TMDB_KEY || '06e955fa0b338a170d7b8dc9710016b0';

const TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.tracker.cl:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://opentracker.i2p.rocks:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function tmdbFetch(path) {
    const res = await fetch(`https://api.themoviedb.org/3${path}?api_key=${TMDB_KEY}`);
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    return res.json();
}

function parseQuality(title = '') {
    if (/2160p|4K|UHD/i.test(title)) return '4K';
    if (/1080p/i.test(title)) return '1080p';
    if (/720p/i.test(title)) return '720p';
    if (/480p/i.test(title)) return '480p';
    return 'SD';
}

function parseSeeders(title = '') {
    const m = title.match(/👤\s*(\d+)/);
    return m ? parseInt(m[1]) : 0;
}

function parseSize(title = '') {
    const m = title.match(/💾\s*([\d.]+\s*(?:GB|MB))/i);
    return m ? m[1] : '';
}

// ------------------------------------------------------------------
// Streams endpoint
// ------------------------------------------------------------------

// GET /streams/:tmdbId?type=movie|tv&season=1&episode=1
app.get('/streams/:tmdbId', async (req, res) => {
    const { tmdbId } = req.params;
    const type    = req.query.type || 'movie';
    const season  = req.query.season  || 1;
    const episode = req.query.episode || 1;

    try {
        // 1. Get IMDB ID from TMDB
        console.log('Fetching IMDB ID for', tmdbId, type);
        const ext = await tmdbFetch(`/${type === 'tv' ? 'tv' : 'movie'}/${tmdbId}/external_ids`);
        const imdbId = ext.imdb_id;
        console.log('IMDB ID:', imdbId);
        if (!imdbId) return res.status(404).json({ message: 'No IMDB ID found for this title' });

        // 2. Fetch streams — movies from YTS, TV from EZTV
        let rawTorrents = [];

        if (type === 'tv') {
            const imdbNum = imdbId.replace('tt', '');
            const ezRes = await fetch(`https://eztv.re/api/get-torrents?imdb_id=${imdbNum}&limit=100`);
            if (ezRes.ok) {
                const ezData = await ezRes.json();
                rawTorrents = (ezData.torrents || [])
                    .filter(t => {
                        const title = t.title || '';
                        const sMatch = title.match(/S(\d+)E(\d+)/i);
                        if (!sMatch) return false;
                        return parseInt(sMatch[1]) === parseInt(season) && parseInt(sMatch[2]) === parseInt(episode);
                    })
                    .map(t => ({
                        quality: parseQuality(t.title),
                        seeders: t.seeds || 0,
                        size: t.size_bytes ? (t.size_bytes / 1e9).toFixed(1) + ' GB' : '',
                        hash: t.hash,
                        magnet: t.magnet_url || `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(t.title)}${TRACKERS}`,
                        fileIdx: 0,
                    }));
            }
        } else {
            const ytsRes = await fetch(`https://yts.mx/api/v2/movie_details.json?imdb_id=${imdbId}&with_images=false&with_cast=false`);
            if (ytsRes.ok) {
                const ytsData = await ytsRes.json();
                rawTorrents = (ytsData.data?.movie?.torrents || []).map(t => ({
                    quality: t.quality + (t.video_codec ? ' ' + t.video_codec : ''),
                    seeders: t.seeds || 0,
                    size: t.size || '',
                    hash: t.hash,
                    magnet: `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(ytsData.data.movie.title_long)}${TRACKERS}`,
                    fileIdx: 0,
                }));
            }
        }

        const streams = rawTorrents
            .filter(t => t.hash || t.magnet)
            .sort((a, b) => b.seeders - a.seeders)
            .slice(0, 10);

        if (!streams.length) return res.status(404).json({ message: 'No streams found for this title' });

        res.json({ streams: streams.map((s, i) => ({ ...s, id: i })) });
    } catch (e) {
        console.error('/streams error:', e.message, e.cause?.message || '');
        res.status(500).json({ message: e.message });
    }
});

// ------------------------------------------------------------------
// Watch Together (Socket.io)
// ------------------------------------------------------------------

const rooms = new Map();
const makeCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

io.on('connection', (socket) => {
    socket.on('room:create', ({ tmdbId, type, season, episode, title, magnet, fileIdx }, cb) => {
        const code = makeCode();
        rooms.set(code, { tmdbId, type, season, episode, title, magnet, fileIdx, host: socket.id, members: 1 });
        socket.join(code);
        socket.roomCode = code;
        cb({ code });
    });

    socket.on('room:join', ({ code }, cb) => {
        const room = rooms.get(code.toUpperCase());
        if (!room) return cb({ error: 'Room not found' });
        socket.join(code.toUpperCase());
        socket.roomCode = code.toUpperCase();
        room.members++;
        cb({ room });
        socket.to(code.toUpperCase()).emit('room:member-joined');
        // Ask host for current playback state
        socket.to(code.toUpperCase()).emit('room:request-state', { for: socket.id });
    });

    socket.on('room:state', ({ for: forId, currentTime, paused }) => {
        io.to(forId).emit('room:sync-state', { currentTime, paused });
    });

    socket.on('player:sync', (data) => {
        if (socket.roomCode) socket.to(socket.roomCode).emit('player:sync', data);
    });

    socket.on('disconnect', () => {
        if (!socket.roomCode) return;
        const room = rooms.get(socket.roomCode);
        if (!room) return;
        room.members--;
        if (room.members <= 0) rooms.delete(socket.roomCode);
        else socket.to(socket.roomCode).emit('room:member-left');
    });
});

// ------------------------------------------------------------------
app.get('/', (_, res) => res.json({ status: 'ok', rooms: rooms.size }));

app.get('/test', async (_, res) => {
    const results = {};
    try {
        const r = await fetch(`https://api.themoviedb.org/3/movie/603/external_ids?api_key=${TMDB_KEY}`);
        results.tmdb = { ok: r.ok, status: r.status, data: await r.json() };
    } catch(e) { results.tmdb = { error: e.message, cause: e.cause?.message }; }

    try {
        const r = await fetch('https://yts.mx/api/v2/movie_details.json?imdb_id=tt0133093');
        results.yts = { ok: r.ok, status: r.status };
    } catch(e) { results.yts = { error: e.message, cause: e.cause?.message }; }

    res.json(results);
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Hespoire API on port ${PORT}`));
