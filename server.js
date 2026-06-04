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
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v)$/i;

// ------------------------------------------------------------------
// WebTorrent client (ESM — loaded via dynamic import)
// ------------------------------------------------------------------
let client = null;
(async () => {
    const WebTorrent = (await import('webtorrent')).default;
    client = new WebTorrent();
    console.log('WebTorrent client ready');
})();

// Get an existing torrent or add it, resolve once metadata is ready
function getReadyTorrent(magnet) {
    return new Promise((resolve, reject) => {
        if (!client) return reject(new Error('Torrent client still starting'));

        // Reuse if already added
        const hashMatch = magnet.match(/btih:([a-z0-9]+)/i);
        const infoHash = hashMatch ? hashMatch[1].toLowerCase() : null;
        const existing = client.torrents.find(t => t.infoHash === infoHash);
        if (existing) {
            if (existing.ready) return resolve(existing);
            existing.once('ready', () => resolve(existing));
            return;
        }

        const torrent = client.add(magnet, { destroyStoreOnDestroy: true });
        const timeout = setTimeout(() => reject(new Error('Timed out finding peers')), 25000);
        torrent.once('ready', () => { clearTimeout(timeout); resolve(torrent); });
        torrent.once('error', (e) => { clearTimeout(timeout); reject(e); });
    });
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
async function tmdbFetch(path) {
    const res = await fetch(`https://api.themoviedb.org/3${path}?api_key=${TMDB_KEY}`);
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    return res.json();
}

// ------------------------------------------------------------------
// Source lookup endpoints
// ------------------------------------------------------------------
app.get('/imdb/:tmdbId', async (req, res) => {
    try {
        const ext = await tmdbFetch(`/${req.query.type === 'tv' ? 'tv' : 'movie'}/${req.params.tmdbId}/external_ids`);
        if (!ext.imdb_id) return res.status(404).json({ message: 'No IMDB ID found' });
        res.json({ imdbId: ext.imdb_id });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.get('/proxy/yts/:imdbId', async (req, res) => {
    try {
        const r = await fetch(`https://yts.am/api/v2/movie_details.json?imdb_id=${req.params.imdbId}&with_images=false&with_cast=false`, { headers: { 'User-Agent': UA } });
        if (!r.ok) return res.status(r.status).json({ message: `YTS ${r.status}` });
        res.json(await r.json());
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.get('/proxy/eztv/:imdbId', async (req, res) => {
    try {
        const imdbNum = req.params.imdbId.replace('tt', '');
        const r = await fetch(`https://eztv.re/api/get-torrents?imdb_id=${imdbNum}&limit=100`, { headers: { 'User-Agent': UA } });
        if (!r.ok) return res.status(r.status).json({ message: `EZTV ${r.status}` });
        res.json(await r.json());
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// ------------------------------------------------------------------
// STREAM endpoint — Node downloads from real seeders, pipes to browser
// GET /stream?magnet=...
// ------------------------------------------------------------------
app.get('/stream', async (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) return res.status(400).send('Missing magnet');

    try {
        const torrent = await getReadyTorrent(magnet);

        // Largest video file in the torrent
        const file = torrent.files
            .filter(f => VIDEO_EXT.test(f.name))
            .sort((a, b) => b.length - a.length)[0];
        if (!file) return res.status(404).send('No video file in torrent');

        // Prioritise streaming this file
        torrent.files.forEach(f => f !== file && f.deselect && f.deselect());
        file.select && file.select();

        const total = file.length;
        const range = req.headers.range;
        const ext = file.name.split('.').pop().toLowerCase();
        const mime = ext === 'webm' ? 'video/webm' : ext === 'mkv' ? 'video/x-matroska' : 'video/mp4';

        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', mime);

        if (range) {
            const [s, e] = range.replace(/bytes=/, '').split('-');
            const start = parseInt(s, 10);
            const end = e ? parseInt(e, 10) : total - 1;
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
            res.setHeader('Content-Length', end - start + 1);
            const stream = file.createReadStream({ start, end });
            stream.on('error', () => res.destroy());
            stream.pipe(res);
            req.on('close', () => stream.destroy());
        } else {
            res.setHeader('Content-Length', total);
            const stream = file.createReadStream();
            stream.on('error', () => res.destroy());
            stream.pipe(res);
            req.on('close', () => stream.destroy());
        }
    } catch (e) {
        console.error('/stream error:', e.message);
        if (!res.headersSent) res.status(500).send(e.message);
    }
});

// Live torrent stats for the player UI
app.get('/stream-stats', (req, res) => {
    const magnet = req.query.magnet || '';
    const hashMatch = magnet.match(/btih:([a-z0-9]+)/i);
    const infoHash = hashMatch ? hashMatch[1].toLowerCase() : null;
    const t = client?.torrents.find(t => t.infoHash === infoHash);
    if (!t) return res.json({ peers: 0, speed: 0, progress: 0 });
    res.json({
        peers: t.numPeers,
        speed: Math.round(t.downloadSpeed),
        progress: +(t.progress * 100).toFixed(1),
    });
});

// ------------------------------------------------------------------
// Watch Together (Socket.io)
// ------------------------------------------------------------------
const rooms = new Map();
const makeCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

io.on('connection', (socket) => {
    socket.on('room:create', (data, cb) => {
        const code = makeCode();
        rooms.set(code, { ...data, host: socket.id, members: 1 });
        socket.join(code); socket.roomCode = code;
        cb({ code });
    });

    socket.on('room:join', ({ code }, cb) => {
        const room = rooms.get(code.toUpperCase());
        if (!room) return cb({ error: 'Room not found' });
        socket.join(code.toUpperCase()); socket.roomCode = code.toUpperCase();
        room.members++;
        cb({ room });
        socket.to(code.toUpperCase()).emit('room:member-joined');
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
app.get('/', (_, res) => res.json({ status: 'ok', torrents: client?.torrents.length || 0, rooms: rooms.size }));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Hespoire API on port ${PORT}`));
