const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { MOVIES } = require('@consumet/extensions');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const TMDB_KEY = process.env.TMDB_KEY || '06e955fa0b338a170d7b8dc9710016b0';
const flixhq = new MOVIES.FlixHQ();

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function tmdbFetch(path) {
    const res = await fetch(`https://api.themoviedb.org/3${path}?api_key=${TMDB_KEY}`);
    if (!res.ok) throw new Error(`TMDB error ${res.status}`);
    return res.json();
}

async function findOnFlixHQ(title, year) {
    const query = year ? `${title} ${year}` : title;
    const results = await flixhq.search(query);
    const items = results.results || [];
    // Best match: exact title or closest
    return (
        items.find(r => r.title?.toLowerCase() === title.toLowerCase()) ||
        items.find(r => r.title?.toLowerCase().includes(title.toLowerCase())) ||
        items[0]
    );
}

// ------------------------------------------------------------------
// Streaming endpoints
// ------------------------------------------------------------------

// GET /meta/tmdb/info/:id?type=movie|tv
app.get('/meta/tmdb/info/:id', async (req, res) => {
    const { id } = req.params;
    const type = req.query.type || 'movie';

    try {
        // 1. Get title + year from TMDB
        const tmdb = await tmdbFetch(type === 'tv' ? `/tv/${id}` : `/movie/${id}`);
        const title = tmdb.title || tmdb.name;
        const year = ((tmdb.release_date || tmdb.first_air_date) || '').substring(0, 4);

        // 2. Find on FlixHQ
        const match = await findOnFlixHQ(title, year);
        if (!match) return res.status(404).json({ message: `"${title}" not found on FlixHQ` });

        // 3. Get full media info (episodes/seasons)
        const info = await flixhq.fetchMediaInfo(match.id);

        res.json({
            id: match.id,           // FlixHQ media ID
            tmdbId: id,
            title,
            type: info.type || type,
            episodes: info.episodes || [],
        });
    } catch (e) {
        console.error('/info error:', e.message);
        res.status(500).json({ message: e.message });
    }
});

// GET /meta/tmdb/watch/:episodeId?id=flixhqMediaId
app.get('/meta/tmdb/watch/:episodeId', async (req, res) => {
    const episodeId = decodeURIComponent(req.params.episodeId);
    const mediaId   = decodeURIComponent(req.query.id || '');

    try {
        const data = await flixhq.fetchEpisodeSources(episodeId, mediaId);
        if (!data || !data.sources?.length) {
            return res.status(404).json({ message: 'No sources found' });
        }
        res.json(data);
    } catch (e) {
        console.error('/watch error:', e.message);
        res.status(500).json({ message: e.message });
    }
});

// ------------------------------------------------------------------
// Watch Together (Socket.io)
// ------------------------------------------------------------------

const rooms = new Map();

function makeCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    // Create a room
    socket.on('room:create', ({ tmdbId, type, season, episode, title }, cb) => {
        const code = makeCode();
        rooms.set(code, { tmdbId, type, season, episode, title, host: socket.id, members: 1 });
        socket.join(code);
        socket.roomCode = code;
        cb({ code });
    });

    // Join existing room
    socket.on('room:join', ({ code }, cb) => {
        const room = rooms.get(code.toUpperCase());
        if (!room) return cb({ error: 'Room not found' });
        socket.join(code.toUpperCase());
        socket.roomCode = code.toUpperCase();
        room.members++;
        cb({ room });
        socket.to(code.toUpperCase()).emit('room:member-joined');
    });

    // Sync play/pause/seek from host to members
    socket.on('player:sync', (data) => {
        if (socket.roomCode) {
            socket.to(socket.roomCode).emit('player:sync', data);
        }
    });

    // Host requests current time from members (to catch up late joiners)
    socket.on('player:request-sync', () => {
        if (socket.roomCode) {
            socket.to(socket.roomCode).emit('player:request-sync', { requester: socket.id });
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomCode) {
            const room = rooms.get(socket.roomCode);
            if (room) {
                room.members--;
                if (room.members <= 0) rooms.delete(socket.roomCode);
                else socket.to(socket.roomCode).emit('room:member-left');
            }
        }
    });
});

// ------------------------------------------------------------------
// Health check
// ------------------------------------------------------------------
app.get('/', (_, res) => res.json({ status: 'ok', rooms: rooms.size }));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Hespoire API running on port ${PORT}`));
