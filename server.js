const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// Torrentio aggregates many indexers — returns streams by IMDB id
// /proxy/torrentio/movie/tt123  OR  /proxy/torrentio/series/tt123?season=1&episode=2
app.get('/proxy/torrentio/:type/:imdbId', async (req, res) => {
    try {
        const { type, imdbId } = req.params;
        const url = type === 'series'
            ? `https://torrentio.strem.fun/stream/series/${imdbId}:${req.query.season || 1}:${req.query.episode || 1}.json`
            : `https://torrentio.strem.fun/stream/movie/${imdbId}.json`;
        const r = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!r.ok) return res.status(r.status).json({ message: `Torrentio ${r.status}` });
        res.json(await r.json());
    } catch (e) {
        res.status(500).json({ message: e.message, cause: e.cause?.message });
    }
});

app.get('/proxy/eztv/:imdbId', async (req, res) => {
    try {
        const imdbNum = req.params.imdbId.replace('tt', '');
        // EZTV returns newest-first, 100/page. Page through so old episodes are found too.
        let all = [];
        let total = Infinity;
        for (let page = 1; page <= 8 && all.length < total; page++) {
            const r = await fetch(`https://eztv.re/api/get-torrents?imdb_id=${imdbNum}&limit=100&page=${page}`, { headers: { 'User-Agent': UA } });
            if (!r.ok) break;
            const data = await r.json();
            total = data.torrents_count || 0;
            const batch = data.torrents || [];
            if (!batch.length) break;
            all = all.concat(batch);
        }
        res.json({ torrents_count: total, torrents: all });
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

    const fileIdx = req.query.fileIdx != null && req.query.fileIdx !== '' ? parseInt(req.query.fileIdx, 10) : null;

    try {
        const torrent = await getReadyTorrent(magnet);

        // Use the exact file index when given (season packs), else largest video file
        let file = null;
        if (fileIdx != null && torrent.files[fileIdx] && VIDEO_EXT.test(torrent.files[fileIdx].name)) {
            file = torrent.files[fileIdx];
        }
        if (!file) {
            file = torrent.files
                .filter(f => VIDEO_EXT.test(f.name))
                .sort((a, b) => b.length - a.length)[0];
        }
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

// ------------------------------------------------------------------
// HLS transcoding — for MKV/EAC3 content (TV) browsers can't play natively
// ffmpeg copies H.264 video (no quality loss), converts audio to AAC,
// segments into HLS so it plays everywhere with working seek.
// ------------------------------------------------------------------
const hlsJobs = new Map(); // infoHash -> { dir, proc, lastAccess }

function probeMedia(inputUrl) {
    return new Promise((resolve) => {
        const p = spawn('ffprobe', ['-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name',
            '-show_entries', 'format=duration',
            '-of', 'json', inputUrl]);
        let out = '';
        p.stdout.on('data', d => out += d);
        p.on('close', () => {
            try {
                const j = JSON.parse(out);
                resolve({ codec: j.streams?.[0]?.codec_name || '', duration: parseFloat(j.format?.duration) || 0 });
            } catch { resolve({ codec: '', duration: 0 }); }
        });
        p.on('error', () => resolve({ codec: '', duration: 0 }));
    });
}

app.get('/hls/start', async (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) return res.status(400).json({ message: 'Missing magnet' });

    const hashMatch = magnet.match(/btih:([a-z0-9]+)/i);
    const infoHash = hashMatch ? hashMatch[1].toLowerCase() : null;
    if (!infoHash) return res.status(400).json({ message: 'Bad magnet' });

    // Key jobs by hash + file index so different episodes in one season pack don't collide
    const fileIdx = req.query.fileIdx != null && req.query.fileIdx !== '' ? req.query.fileIdx : null;
    const jobKey = infoHash + (fileIdx != null ? '_' + fileIdx : '');

    // Reuse existing job
    const existing = hlsJobs.get(jobKey);
    if (existing) {
        existing.lastAccess = Date.now();
        return res.json({ url: `/hls/${jobKey}/index.m3u8` });
    }

    const dir = path.join(os.tmpdir(), 'hls_' + jobKey);
    fs.mkdirSync(dir, { recursive: true });
    const input = `http://127.0.0.1:${PORT}/stream?magnet=${encodeURIComponent(magnet)}${fileIdx != null ? `&fileIdx=${fileIdx}` : ''}`;

    // Probe codec (copy vs re-encode) and total duration (for a proper VOD playlist)
    const { codec, duration } = await probeMedia(input);

    // H.264 → copy (instant, lossless). Anything else (HEVC etc.) must re-encode —
    // ultrafast + zerolatency so it keeps up with realtime playback.
    const vArgs = codec === 'h264'
        ? ['-c:v', 'copy']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '26'];

    // When we know the duration, hand the player a COMPLETE VOD playlist (correct
    // total length + working seek bar). ffmpeg writes its own playlist to ff.m3u8
    // (ignored); segments fill in as it transcodes.
    const SEG = 6;
    const useVod = duration > SEG;
    const ffPlaylist = useVod ? path.join(dir, 'ff.m3u8') : path.join(dir, 'index.m3u8');

    const args = [
        '-i', input,
        ...vArgs,
        '-c:a', 'aac', '-ac', '2', '-b:a', '128k',
        '-f', 'hls',
        '-hls_time', String(SEG),
        '-hls_list_size', '0',
        '-hls_flags', 'independent_segments',
        '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
        ffPlaylist,
    ];

    const proc = spawn('ffmpeg', args);
    proc.stderr.on('data', () => {}); // swallow ffmpeg logging
    proc.on('error', (e) => console.error('ffmpeg spawn error:', e.message));

    hlsJobs.set(jobKey, { dir, proc, lastAccess: Date.now() });

    if (useVod) {
        const n = Math.ceil(duration / SEG);
        let pl = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' + (SEG + 1) +
            '\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n';
        for (let i = 0; i < n; i++) {
            const d = (i === n - 1) ? (duration - i * SEG) : SEG;
            pl += `#EXTINF:${d.toFixed(3)},\nseg_${String(i).padStart(5, '0')}.ts\n`;
        }
        pl += '#EXT-X-ENDLIST\n';
        fs.writeFileSync(path.join(dir, 'index.m3u8'), pl);
    }

    // Resolve once index.m3u8 + first segment exist
    const t0 = Date.now();
    const wait = setInterval(() => {
        const ready = fs.existsSync(path.join(dir, 'index.m3u8')) && fs.existsSync(path.join(dir, 'seg_00000.ts'));
        if (ready) { clearInterval(wait); res.json({ url: `/hls/${jobKey}/index.m3u8` }); }
        else if (Date.now() - t0 > 35000) {
            clearInterval(wait);
            if (!res.headersSent) res.status(500).json({ message: 'Transcode timed out (no seeders?)' });
        }
    }, 400);
});

app.get('/hls/:hash/:file', (req, res) => {
    const job = hlsJobs.get(req.params.hash);
    if (!job) return res.status(404).end();
    job.lastAccess = Date.now();
    const file = path.join(job.dir, path.basename(req.params.file));
    if (!fs.existsSync(file)) return res.status(404).end();
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (file.endsWith('.m3u8')) res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    else if (file.endsWith('.ts')) res.setHeader('Content-Type', 'video/mp2t');
    fs.createReadStream(file).pipe(res);
});

// Clean up idle transcode jobs (kill ffmpeg, delete temp segments)
setInterval(() => {
    const now = Date.now();
    for (const [hash, job] of hlsJobs) {
        if (now - job.lastAccess > 5 * 60 * 1000) {
            try { job.proc.kill('SIGKILL'); } catch {}
            try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch {}
            hlsJobs.delete(hash);
        }
    }
}, 60000);

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
