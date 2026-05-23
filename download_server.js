/**
 * IGNITE Extension Download Server v1.1
 * Dedicated server for browser extension HLS downloads using ffmpeg
 * 
 * Features:
 * - Receives M3U8 URL from extension
 * - Supports up to 10 parallel downloads
 * - Downloads segments with 32 threads per download
 * - Combines with ffmpeg to MP4
 * - Real-time status API for extension popup
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { URL } = require('url');

// HTTP agents for connection reuse (keep-alive) - much faster!
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 50,
    timeout: 30000
});
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 50,
    timeout: 30000
});

// ============ CONFIG ============
const PORT = 3003;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const TEMP_DIR = path.join(__dirname, 'temp');
const PARALLEL_THREADS = 64;  // Increased for faster downloads
const MAX_CONCURRENT_DOWNLOADS = 10;

// Ensure directories exist
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ============ STATE ============
// Map of active downloads: id -> download state
const activeDownloads = new Map();
const pausedDownloads = new Set();   // IDs of paused downloads
const cancelledDownloads = new Set(); // IDs of cancelled downloads
let downloadIdCounter = 0;

const logs = [];
const MAX_LOGS = 150;

// ============ LOGGING ============
function log(msg, downloadId = null) {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = downloadId ? `[#${downloadId}]` : '';
    const logLine = `[${timestamp}]${prefix} ${msg}`;
    console.log(logLine);
    logs.push(logLine);
    if (logs.length > MAX_LOGS) logs.shift();
}

// ============ EXPRESS APP ============
const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS for browser extension
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ============ STATUS API ============
app.get('/api/status', (req, res) => {
    // Get all downloads as array
    const downloads = Array.from(activeDownloads.values());

    // Find the most active one to show as "current"
    const active = downloads.find(d => d.phase === 'downloading')
        || downloads.find(d => d.phase === 'combining')
        || downloads.find(d => d.phase === 'fetching')
        || downloads[0];

    res.json({
        // Legacy single-download format for popup compatibility
        active: downloads.length > 0,
        filename: active?.filename || '',
        folderPath: active?.folderPath || '',
        phase: downloads.length === 0 ? 'idle' : (active?.phase || 'idle'),
        progress: active?.progress || 0,
        total: active?.total || 0,
        bytes: active?.bytes || 0,
        speed: active?.speed || 0,
        message: active?.message || '',

        // Extended multi-download info
        totalDownloads: downloads.length,
        maxDownloads: MAX_CONCURRENT_DOWNLOADS,
        downloads: downloads.map(d => ({
            id: d.id,
            filename: d.filename,
            phase: d.phase,
            progress: d.progress,
            total: d.total,
            message: d.message,
            duration: d.duration || 0,
            paused: pausedDownloads.has(d.id)
        })),

        logs: logs.slice(-25),
        downloadDir: DOWNLOAD_DIR
    });
});

// ============ CONTROL APIs ============
// Pause a download
app.post('/api/pause/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (activeDownloads.has(id)) {
        pausedDownloads.add(id);
        const dl = activeDownloads.get(id);
        dl.phase = 'paused';
        log(`⏸️ PAUSED: ${dl.filename}`, id);
        res.json({ success: true });
    } else {
        res.json({ success: false, error: 'Download not found' });
    }
});

// Resume a download
app.post('/api/resume/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (activeDownloads.has(id)) {
        pausedDownloads.delete(id);
        const dl = activeDownloads.get(id);
        dl.phase = 'downloading';
        log(`▶️ RESUMED: ${dl.filename}`, id);
        res.json({ success: true });
    } else {
        res.json({ success: false, error: 'Download not found' });
    }
});

// Cancel a download
app.post('/api/cancel/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (activeDownloads.has(id)) {
        cancelledDownloads.add(id);
        pausedDownloads.delete(id);
        const dl = activeDownloads.get(id);
        dl.phase = 'cancelled';
        log(`🛑 CANCELLED: ${dl.filename}`, id);
        // Remove from active downloads
        setTimeout(() => activeDownloads.delete(id), 1000);
        res.json({ success: true });
    } else {
        res.json({ success: false, error: 'Download not found' });
    }
});

// Cancel all downloads
app.post('/api/cancel-all', (req, res) => {
    const count = activeDownloads.size;
    activeDownloads.forEach((dl, id) => {
        cancelledDownloads.add(id);
        dl.phase = 'cancelled';
    });
    log(`🛑 CANCELLED ALL: ${count} downloads`);
    setTimeout(() => activeDownloads.clear(), 1000);
    res.json({ success: true, cancelled: count });
});

// ============ DOWNLOAD API ============
app.post('/api/extension-download', async (req, res) => {
    const { m3u8Url, folderPath, filename, headers } = req.body;

    if (!m3u8Url) {
        return res.json({ success: false, error: 'M3U8 URL required' });
    }

    // Check if we've hit the limit
    if (activeDownloads.size >= MAX_CONCURRENT_DOWNLOADS) {
        log(`⚠️ Queue full (${activeDownloads.size}/${MAX_CONCURRENT_DOWNLOADS})`);
        return res.json({
            success: false,
            error: `Maximum ${MAX_CONCURRENT_DOWNLOADS} downloads in progress. Please wait.`
        });
    }

    const downloadId = ++downloadIdCounter;
    const safeFilename = (filename || 'video').replace(/[<>:"/\\|?*]/g, '_').substring(0, 80);
    const safeFolderPath = (folderPath || '').replace(/[<>:"|?*]/g, '_');

    // Create download state
    const downloadState = {
        id: downloadId,
        filename: safeFilename,
        folderPath: safeFolderPath,
        phase: 'starting',
        progress: 0,
        total: 0,
        bytes: 0,
        speed: 0,
        startTime: Date.now(),
        message: 'Starting download...'
    };

    activeDownloads.set(downloadId, downloadState);

    log(`\n${'='.repeat(60)}`, downloadId);
    log(`📥 NEW DOWNLOAD #${downloadId}: ${safeFilename}`, downloadId);
    log(`📁 Folder: ${safeFolderPath || 'root'}`, downloadId);
    log(`🔗 M3U8: ${m3u8Url.substring(0, 60)}...`, downloadId);
    log(`📊 Active downloads: ${activeDownloads.size}/${MAX_CONCURRENT_DOWNLOADS}`, downloadId);
    log(`${'='.repeat(60)}`, downloadId);

    res.json({
        success: true,
        message: 'Download started',
        downloadId,
        filename: safeFilename,
        queuePosition: activeDownloads.size
    });

    // Process in background
    processDownload(downloadId, m3u8Url, safeFolderPath, safeFilename, headers || {});
});

// ============ DOWNLOAD PROCESSOR ============
async function processDownload(downloadId, m3u8Url, folderPath, filename, headers) {
    const state = activeDownloads.get(downloadId);
    if (!state) return;

    const sessionTempDir = path.join(TEMP_DIR, `dl_${downloadId}_${Date.now()}`);

    const updateState = (phase, message, progress = null, total = null) => {
        state.phase = phase;
        state.message = message;
        if (progress !== null) state.progress = progress;
        if (total !== null) state.total = total;
    };

    try {
        // Create temp directory
        if (!fs.existsSync(sessionTempDir)) {
            fs.mkdirSync(sessionTempDir, { recursive: true });
        }

        // Create output directory
        const outputDir = folderPath
            ? path.join(DOWNLOAD_DIR, folderPath)
            : DOWNLOAD_DIR;
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // STEP 1: Fetch M3U8
        updateState('fetching', 'Fetching M3U8...');
        log(`📋 Fetching M3U8...`, downloadId);
        const m3u8Content = await fetchUrl(m3u8Url, headers);
        log(`✅ M3U8 fetched: ${m3u8Content.length} bytes`, downloadId);

        // Parse segments and duration
        const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
        const { segments, totalDuration } = parseM3U8(m3u8Content, baseUrl);

        if (segments.length === 0) {
            throw new Error('No segments found in M3U8');
        }

        // Store duration in state
        state.duration = totalDuration;
        const durationStr = totalDuration > 0 ? ` (${Math.floor(totalDuration / 60)}m ${Math.floor(totalDuration % 60)}s)` : '';
        log(`📊 Found ${segments.length} segments${durationStr}`, downloadId);
        state.total = segments.length;

        // STEP 2: Download segments
        updateState('downloading', `0/${segments.length}`, 0, segments.length);

        const segmentFiles = [];
        let downloadedBytes = 0;
        const startTime = Date.now();

        // Download in parallel batches
        for (let i = 0; i < segments.length; i += PARALLEL_THREADS) {
            // Check for cancellation
            if (cancelledDownloads.has(downloadId)) {
                throw new Error('Download cancelled by user');
            }

            // Wait while paused
            while (pausedDownloads.has(downloadId)) {
                await sleep(500);
                if (cancelledDownloads.has(downloadId)) {
                    throw new Error('Download cancelled by user');
                }
            }

            const batch = segments.slice(i, i + PARALLEL_THREADS);
            const batchPromises = batch.map(async (segUrl, j) => {
                const index = i + j;
                const segPath = path.join(sessionTempDir, `seg_${index.toString().padStart(5, '0')}.ts`);

                for (let retry = 0; retry < 3; retry++) {
                    try {
                        const bytes = await downloadFile(segUrl, segPath, headers);
                        downloadedBytes += bytes;
                        return { path: segPath, bytes };
                    } catch (e) {
                        if (retry === 2) {
                            log(`⚠️ Seg ${index} failed: ${e.message}`, downloadId);
                            throw e;
                        }
                        await sleep(500);
                    }
                }
            });

            const results = await Promise.all(batchPromises);
            segmentFiles.push(...results.map(r => r.path));

            // Update progress
            const done = Math.min(i + PARALLEL_THREADS, segments.length);
            const elapsed = (Date.now() - startTime) / 1000;
            const speed = elapsed > 0 ? downloadedBytes / elapsed : 0;

            state.progress = done;
            state.bytes = downloadedBytes;
            state.speed = speed;
            state.message = `${done}/${segments.length}`;

            if (done % 64 === 0 || done === segments.length) {
                const speedMB = (speed / 1024 / 1024).toFixed(1);
                log(`⬇️ ${done}/${segments.length} (${speedMB} MB/s)`, downloadId);
            }
        }

        log(`✅ All segments downloaded (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB)`, downloadId);

        // STEP 3: Combine with FFmpeg
        updateState('combining', 'FFmpeg...');
        log(`🔧 FFmpeg combining...`, downloadId);
        const outputPath = path.join(outputDir, `${filename}.mp4`);

        await combineWithFFmpeg(segmentFiles, outputPath, downloadId);

        const fileSize = fs.statSync(outputPath).size;
        log(`✅ COMPLETE: ${filename}.mp4 (${(fileSize / 1024 / 1024).toFixed(1)} MB)`, downloadId);

        // Cleanup temp folder
        try {
            fs.rmSync(sessionTempDir, { recursive: true, force: true });
            log(`🗑️ Cleaned up temp folder`, downloadId);
        } catch (e) {
            log(`⚠️ Temp cleanup failed: ${e.message}`, downloadId);
        }

        // Update final status and remove from active
        state.phase = 'complete';
        state.message = `${filename}.mp4`;

        // Keep in list for 5 seconds so popup can see completion
        setTimeout(() => {
            activeDownloads.delete(downloadId);
            log(`🗑️ Removed #${downloadId} from queue (${activeDownloads.size} remaining)`);
        }, 5000);

    } catch (e) {
        log(`❌ ERROR: ${e.message}`, downloadId);
        state.phase = 'error';
        state.message = e.message;

        // Cleanup on error
        try { fs.rmSync(sessionTempDir, { recursive: true, force: true }); } catch { }

        // Remove after 10 seconds
        setTimeout(() => {
            activeDownloads.delete(downloadId);
        }, 10000);
    }
}

// ============ HELPERS ============
function parseM3U8(content, baseUrl) {
    const lines = content.split('\n');
    const segments = [];
    let totalDuration = 0;
    let lastDuration = 0;

    for (const line of lines) {
        const trimmed = line.trim();

        // Parse EXTINF to get duration
        if (trimmed.startsWith('#EXTINF:')) {
            const match = trimmed.match(/#EXTINF:([0-9.]+)/);
            if (match) {
                lastDuration = parseFloat(match[1]);
            }
        }
        // Parse segment URLs
        else if (trimmed && !trimmed.startsWith('#')) {
            const segUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
            segments.push(segUrl);
            totalDuration += lastDuration;
            lastDuration = 0;
        }
    }

    return { segments, totalDuration };
}

function fetchUrl(url, customHeaders = {}) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const urlObj = new URL(url);

        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
                ...customHeaders
            }
        };

        const req = client.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchUrl(res.headers.location, customHeaders).then(resolve).catch(reject);
            }

            let data = [];
            res.on('data', chunk => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data).toString('utf-8')));
        });

        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

function downloadFile(url, outputPath, customHeaders = {}) {
    return new Promise((resolve, reject) => {
        const isHttps = url.startsWith('https');
        const client = isHttps ? https : http;
        const urlObj = new URL(url);

        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            agent: isHttps ? httpsAgent : httpAgent,  // Reuse connections!
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
                'Connection': 'keep-alive',
                ...customHeaders
            }
        };

        const req = client.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadFile(res.headers.location, outputPath, customHeaders).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }

            let bytes = 0;
            const file = fs.createWriteStream(outputPath);
            res.on('data', chunk => { bytes += chunk.length; });
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(bytes); });
            file.on('error', (e) => { fs.unlink(outputPath, () => { }); reject(e); });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

function combineWithFFmpeg(segmentFiles, outputPath, downloadId) {
    return new Promise((resolve, reject) => {
        const concatFile = path.join(TEMP_DIR, `concat_${downloadId}_${Date.now()}.txt`);
        const content = segmentFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
        fs.writeFileSync(concatFile, content);

        const ffmpeg = spawn('ffmpeg', [
            '-f', 'concat',
            '-safe', '0',
            '-i', concatFile,
            '-c', 'copy',
            '-bsf:a', 'aac_adtstoasc',
            '-y',
            outputPath
        ]);

        ffmpeg.on('close', code => {
            try { fs.unlinkSync(concatFile); } catch { }

            if (code === 0) {
                log('✅ FFmpeg done', downloadId);
                resolve(outputPath);
            } else {
                reject(new Error(`FFmpeg exit ${code}`));
            }
        });

        ffmpeg.on('error', reject);
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============ START SERVER ============
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║      🚀 IGNITE Extension Download Server v1.1                 ║
║                                                               ║
║      Status: http://localhost:${PORT}/api/status                 ║
║      Max parallel downloads: ${MAX_CONCURRENT_DOWNLOADS}                              ║
║      Downloads: ${DOWNLOAD_DIR.substring(0, 42).padEnd(42)}  ║
║                                                               ║
║      Ready for extension downloads!                           ║
╚═══════════════════════════════════════════════════════════════╝
    `);
    log('Server started - accepting up to 10 parallel downloads');
});
