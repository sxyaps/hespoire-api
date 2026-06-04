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

// GET /imdb/:tmdbId?type=movie|tv  — just resolves TMDB ID → IMDB ID
// The client handles torrent searching directly (avoids server-side domain blocks)
app.get('/imdb/:tmdbId', async (req, res) => {
    const { tmdbId } = req.params;
    const type = req.query.type || 'movie';
    try {
        const ext = await tmdbFetch(`/${type === 'tv' ? 'tv' : 'movie'}/${tmdbId}/external_ids`);
        if (!ext.imdb_id) return res.status(404).json({ message: 'No IMDB ID found' });
        res.json({ imdbId: ext.imdb_id });
    } catch (e) {
        console.error('/imdb error:', e.message);
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

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Hespoire API on port ${PORT}`));
