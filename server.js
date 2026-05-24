const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const api = require('./api');
const downloader = require('./downloader');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// App State
let activeCourseId = 673;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Set up downloader socket
downloader.init(io);

// Auth Health Check
app.get('/api/auth/status', async (req, res) => {
    try {
        const result = await api.checkAuth();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cache Management
app.get('/api/cache/stats', (req, res) => {
    res.json(api.getCacheStats());
});

app.post('/api/cache/clear', (req, res) => {
    const cleared = api.clearCache();
    res.json({ success: true, entriesCleared: cleared });
});

// API Routes
app.get('/api/folders', async (req, res) => {
    try {
        const { parentId } = req.query;
        const data = await api.getFolderContents(activeCourseId, parentId || -1);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/video', async (req, res) => {
    try {
        const { courseId, videoId } = req.query;
        const data = await api.getVideoDetails(courseId, videoId);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/download', async (req, res) => {
    try {
        const { videoId, courseId, title, quality = '720p', folderPath = [], duration = '' } = req.body;

        // Instant pre-flight check to save API fetching time for existing files
        const skipReason = downloader.checkSkip(videoId, title || `Video_${videoId}`, quality, folderPath);
        if (skipReason) {
            return res.json({ success: true, taskId: skipReason, status: 'skipped' });
        }

        // Queue with courseId — URL fetched lazily right before download starts
        const taskId = downloader.addDownload({
            id: videoId,
            courseId: courseId || activeCourseId,
            title: title || `Video_${videoId}`,
            url: null,
            quality,
            folderPath,
            duration
        });

        res.json({ success: true, taskId, status: 'queued' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/download-pdf', async (req, res) => {
    try {
        const { videoId, courseId, title, folderPath = [] } = req.body;

        const safeTitle = (title || `Video_${videoId}`).replace(/[\\/:*?"<>|]/g, '').trim();

        // Check if PDF already exists on disk
        const skipReason = downloader.checkSkipPdf(videoId, safeTitle, folderPath);
        if (skipReason) {
            return res.json({ success: true, taskId: skipReason, status: 'skipped' });
        }

        // Queue with courseId — PDF URL fetched lazily
        const taskId = downloader.addPdfDownload({
            id: videoId,
            courseId: courseId || activeCourseId,
            title: title || `Video_${videoId}`,
            url: null,
            folderPath
        });

        res.json({ success: true, taskId, status: 'queued' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---- Batch Download Endpoints (lazy URL resolution — no upfront API calls) ----

app.post('/api/download-batch', async (req, res) => {
    try {
        const { videos, quality = '720p' } = req.body;
        if (!Array.isArray(videos) || videos.length === 0) {
            return res.status(400).json({ error: 'videos must be a non-empty array' });
        }

        const videoInfos = videos.map(v => ({
            id: v.videoId,
            courseId: v.courseId || activeCourseId,
            title: v.title || `Video_${v.videoId}`,
            url: null,
            quality,
            folderPath: v.folderPath || [],
            duration: v.duration || ''
        }));

        const { queued, skipped } = downloader.addDownloadBatch(videoInfos);
        res.json({ success: true, queued, skipped, errors: [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/download-pdf-batch', async (req, res) => {
    try {
        const { videos } = req.body;
        if (!Array.isArray(videos) || videos.length === 0) {
            return res.status(400).json({ error: 'videos must be a non-empty array' });
        }

        const pdfInfos = videos.map(v => ({
            id: v.videoId,
            courseId: v.courseId || activeCourseId,
            title: v.title || `Video_${v.videoId}`,
            url: null,
            folderPath: v.folderPath || []
        }));

        const { queued, skipped } = downloader.addPdfDownloadBatch(pdfInfos);
        res.json({ success: true, queued, skipped, errors: [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Individual Controls
app.post('/api/queue/task/:id/pause', (req, res) => {
    downloader.pauseTask(req.params.id);
    res.json({ success: true });
});

app.post('/api/queue/task/:id/resume', (req, res) => {
    downloader.resumeTask(req.params.id);
    res.json({ success: true });
});

app.post('/api/queue/task/:id/cancel', (req, res) => {
    downloader.cancelTask(req.params.id);
    res.json({ success: true });
});


app.post('/api/queue/pause', (req, res) => {
    downloader.pauseAll();
    res.json({ success: true });
});

app.post('/api/queue/resume', (req, res) => {
    downloader.resumeAll();
    res.json({ success: true });
});

app.post('/api/queue/concurrency', (req, res) => {
    const { max } = req.body;
    if (max && typeof max === 'number') {
        downloader.setConcurrency(max);
        res.json({ success: true, max });
    } else {
        res.status(400).json({ error: 'Invalid concurrency value' });
    }
});

app.get('/api/config/path', (req, res) => {
    res.json({ path: downloader.getBasePath() });
});

app.post('/api/config/path', (req, res) => {
    const { path: newPath } = req.body;
    if (downloader.setBasePath(newPath)) {
        res.json({ success: true, path: downloader.getBasePath() });
    } else {
        res.status(400).json({ error: 'Invalid path' });
    }
});

// Course ID Configuration Routes
app.get('/api/config/course', (req, res) => {
    res.json({ courseId: activeCourseId });
});

app.post('/api/config/course', (req, res) => {
    const { courseId } = req.body;
    const parsedId = parseInt(courseId, 10);
    if (!isNaN(parsedId) && parsedId > 0) {
        activeCourseId = parsedId;
        // Optionally emit to other clients if needed, but usually UI fetches on its own
        res.json({ success: true, courseId: activeCourseId });
    } else {
        res.status(400).json({ error: 'Invalid course ID' });
    }
});

// Bulk check which videos are already downloaded on disk
app.post('/api/check-downloaded', (req, res) => {
    try {
        const { videos, quality = '720p', mode = 'video' } = req.body;
        if (!Array.isArray(videos)) {
            return res.status(400).json({ error: 'videos must be an array' });
        }
        const results = downloader.bulkCheckDownloaded(videos, quality, mode);
        res.json({ results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Socket Events
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    // Send current queue state right away
    socket.emit('queue_init', downloader.getQueueState());
});

const PORT = 3000;
server.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);

    // Check token on startup
    console.log('\n🔐 Checking auth token...');
    try {
        const auth = await api.checkAuth();
        console.log(`   Token issued: ${auth.issuedAt}`);
        console.log(`   Token age:    ${auth.ageDays} days (${auth.ageHours} hours)`);
        console.log(`   Status:       ${auth.message}`);
        if (!auth.authenticated) {
            console.log('\n⚠️  WARNING: Token is not working! Update the authorization header in api.js');
        }
    } catch (err) {
        console.log('   ❌ Could not check auth:', err.message);
    }
    console.log('');
});
