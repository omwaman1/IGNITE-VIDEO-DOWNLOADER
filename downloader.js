const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { URL } = require('url');
const api = require('./api');

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 50, timeout: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 50, timeout: 30000 });

let io = null;
let maxConcurrent = 3;
let activeDownloads = 0;
let queue = [];
let paused = false;
let baseDownloadPath = path.join(__dirname, 'downloads'); // Default initial path
let tasks = {}; // Store task meta and running processes

function init(socketIoInstance) {
    io = socketIoInstance;
    // Create downloads dir
    const downloadsDir = baseDownloadPath;
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir);
    }
}

let lastEmitTime = 0;
let emitTimeout = null;

function broadcastState() {
    if (!io) return;

    const now = Date.now();
    if (now - lastEmitTime < 500) {
        if (!emitTimeout) {
            emitTimeout = setTimeout(() => {
                emitTimeout = null;
                broadcastStateNow();
            }, 500);
        }
        return;
    }
    broadcastStateNow();
}

function broadcastStateNow() {
    lastEmitTime = Date.now();
    io.emit('queue_update', getQueueState());
}

function getQueueState() {
    return {
        paused,
        maxConcurrent,
        baseDownloadPath,
        activeCount: activeDownloads,
        queueLength: queue.length,
        tasks: Object.values(tasks).map(t => ({
            id: t.id,
            title: t.title,
            quality: t.quality,
            duration: t.duration,
            status: t.status,
            progress: t.progress,
            error: t.error
        }))
    };
}

function setBasePath(newPath) {
    if (newPath && typeof newPath === 'string') {
        baseDownloadPath = newPath;
        broadcastState();
        return true;
    }
    return false;
}

function getBasePath() {
    return baseDownloadPath;
}

function setConcurrency(max) {
    maxConcurrent = max;
    broadcastState();
    processQueue();
}

function pauseAll() {
    paused = true;
    for (const taskId in tasks) {
        if (tasks[taskId].status === 'downloading') {
            pauseTask(taskId);
        }
    }
    broadcastState();
}

function resumeAll() {
    paused = false;
    for (const taskId in tasks) {
        if (tasks[taskId].status === 'paused') {
            resumeTask(taskId);
        }
    }
    processQueue();
    broadcastState();
}

function pauseTask(taskId) {
    const task = tasks[taskId];
    if (task && task.status === 'downloading' && task.process) {
        try {
            task.process.kill('SIGSTOP');
            task.status = 'paused';
            broadcastState();
        } catch (e) { console.error('Failed to pause', e); }
    }
}

function resumeTask(taskId) {
    const task = tasks[taskId];
    if (task && task.status === 'paused' && task.process) {
        try {
            task.process.kill('SIGCONT');
            task.status = 'downloading';
            broadcastState();
        } catch (e) { console.error('Failed to resume', e); }
    }
}

function cancelTask(taskId) {
    const task = tasks[taskId];
    if (!task) return;

    if ((task.status === 'downloading' || task.status === 'paused' || task.status === 'encoding') && task.process) {
        try {
            task.process.kill('SIGKILL');
        } catch (e) { console.error('Failed to cancel', e); }
        task.process = null;
        if (task.status === 'encoding') {
            activeEncodes--;
        } else {
            activeDownloads--;
        }
    } else {
        // Remove from queue if not started
        queue = queue.filter(id => id !== taskId);
        if (typeof encodeQueue !== 'undefined') {
            encodeQueue = encodeQueue.filter(item => item.taskId !== taskId);
        }
    }

    task.status = 'error';
    task.error = 'Cancelled by user';

    // Optionally delete partial file
    if (fs.existsSync(task.outputPath)) {
        try { fs.unlinkSync(task.outputPath); } catch (e) { }
    }
    const tempPath = task.outputPath + '.raw.mp4';
    if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (e) { }
    }

    broadcastState();
    processQueue();
}

function fileExistsAndValid(filePath) {
    if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.size > 1024) return true;
    }
    return false;
}

function checkSkip(videoId, title, quality, folderPath) {
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '').trim();
    const paths = folderPath || [];
    const safePaths = paths.map(p => p.replace(/[\\/:*?"<>|]/g, '').trim());
    const targetDir = path.join(baseDownloadPath, ...safePaths);

    // Check both with and without quality suffix
    const withQuality = path.join(targetDir, `${safeTitle}_${quality}.mp4`);
    const withoutQuality = path.join(targetDir, `${safeTitle}.mp4`);

    if (fileExistsAndValid(withQuality) || fileExistsAndValid(withoutQuality)) {
        return `Skipped ${videoId}`;
    }

    // Auto-skip logic for videos already in the active download queue
    const isAlreadyQueued = Object.values(tasks).some(t => t.videoId === videoId && ['queued', 'downloading', 'paused', 'encoding'].includes(t.status));
    if (isAlreadyQueued) {
        return `Already queued ${videoId}`;
    }

    return false;
}

function addDownload(videoInfo) {
    const skipReason = checkSkip(videoInfo.id, videoInfo.title, videoInfo.quality, videoInfo.folderPath);
    if (skipReason) return skipReason;

    const taskId = `${videoInfo.id}_${Date.now()}`;
    const safeTitle = videoInfo.title.replace(/[\\/:*?"<>|]/g, '').trim();
    const paths = videoInfo.folderPath || [];
    const safePaths = paths.map(p => p.replace(/[\\/:*?"<>|]/g, '').trim());

    const targetDir = path.join(baseDownloadPath, ...safePaths);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const outputPath = path.join(targetDir, `${safeTitle}_${videoInfo.quality}.mp4`);

    tasks[taskId] = {
        id: taskId,
        videoId: videoInfo.id,
        courseId: videoInfo.courseId,
        title: videoInfo.title,
        quality: videoInfo.quality,
        url: videoInfo.url || null,  // may be null for lazy resolution
        duration: videoInfo.duration || '',
        durationSecs: 0,
        status: 'queued',
        progress: 0,
        outputPath: outputPath,
        process: null
    };

    queue.push(taskId);
    broadcastState();
    processQueue();
    return taskId;
}

function checkSkipPdf(videoId, title, folderPath) {
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '').trim();
    const paths = folderPath || [];
    const safePaths = paths.map(p => p.replace(/[\\/:*?"<>|]/g, '').trim());
    const targetDir = path.join(baseDownloadPath, ...safePaths);
    const outputPath = path.join(targetDir, `${safeTitle}.pdf`);

    if (fileExistsAndValid(outputPath)) {
        return `Skipped PDF ${videoId}`;
    }

    const isAlreadyQueued = Object.values(tasks).some(t => t.videoId === videoId && t.isPdf && ['queued', 'downloading', 'paused'].includes(t.status));
    if (isAlreadyQueued) {
        return `Already queued PDF ${videoId}`;
    }

    return false;
}

function addPdfDownload(pdfInfo) {
    const safeTitle = pdfInfo.title.replace(/[\\/:*?"<>|]/g, '').trim();
    const skipReason = checkSkipPdf(pdfInfo.id, pdfInfo.title, pdfInfo.folderPath);
    if (skipReason) return skipReason;

    const taskId = `pdf_${pdfInfo.id}_${Date.now()}`;
    const paths = pdfInfo.folderPath || [];
    const safePaths = paths.map(p => p.replace(/[\\/:*?"<>|]/g, '').trim());

    const targetDir = path.join(baseDownloadPath, ...safePaths);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const outputPath = path.join(targetDir, `${safeTitle}.pdf`);

    tasks[taskId] = {
        id: taskId,
        videoId: pdfInfo.id,
        courseId: pdfInfo.courseId,
        title: pdfInfo.title,
        quality: 'PDF',
        url: pdfInfo.url || null,
        duration: '',
        durationSecs: 0,
        status: 'queued',
        progress: 0,
        outputPath: outputPath,
        process: null,
        isPdf: true
    };

    queue.push(taskId);
    broadcastState();
    processQueue();
    return taskId;
}

function timeToSec(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    let secs = 0;
    if (parts.length === 3) {
        secs += parseInt(parts[0], 10) * 3600;
        secs += parseInt(parts[1], 10) * 60;
        secs += parseFloat(parts[2]);
    } else if (parts.length === 2) {
        secs += parseInt(parts[0], 10) * 60;
        secs += parseFloat(parts[1]);
    }
    return secs;
}

function processQueue() {
    if (paused) return;

    // Fill all available concurrency slots — don't just start one
    while (activeDownloads < maxConcurrent && queue.length > 0) {
        const taskId = queue.shift();
        const task = tasks[taskId];
        if (!task) continue;

        // Route PDF downloads differently
        if (task.isPdf) {
            downloadPdf(taskId, task); // increments activeDownloads inside
            continue;
        }

        task.status = 'downloading';
        activeDownloads++;
        broadcastState();

        // Fire-and-forget — don't await so the loop can start more downloads
        startDownload(taskId, task);
    }
}

async function startDownload(taskId, task) {
    try {
        // Lazy URL resolution: fetch a fresh URL right before downloading
        // so signed URLs don't expire while sitting in the queue
        if (!task.url && task.courseId && task.videoId) {
            console.log(`🔗 Fetching fresh URL for ${task.title}...`);
            const videoData = await api.getVideoDetails(task.courseId, task.videoId);
            const linkObj = videoData.download_links.find(l => l.quality === task.quality) || videoData.download_links[0];
            task.url = linkObj ? linkObj.url : videoData.file_link_decrypted;
            if (!task.url) throw new Error('No download URL available');
        }

        const sessionTempDir = path.join(baseDownloadPath, `temp_dl_${taskId}`);
        if (!fs.existsSync(sessionTempDir)) {
            fs.mkdirSync(sessionTempDir, { recursive: true });
        }

        const headers = { 'Referer': 'https://web.classx.co.in/' };
        
        // 1. Fetch M3U8
        const m3u8Content = await fetchUrl(task.url, headers);
        const baseUrl = task.url.substring(0, task.url.lastIndexOf('/') + 1);
        const { segments, totalDuration } = parseM3U8(m3u8Content, baseUrl, task.url);

        if (segments.length === 0) throw new Error('No segments found in M3U8');

        task.durationSecs = totalDuration;
        if (!task.duration) {
            task.duration = `${Math.floor(totalDuration / 60)}m ${Math.floor(totalDuration % 60)}s`;
        }
        
        // 2. Download segments in parallel batches
        const PARALLEL_THREADS = 64;
        const segmentFiles = [];
        let downloadedBytes = 0;
        let downloadedChunks = 0;
        
        for (let i = 0; i < segments.length; i += PARALLEL_THREADS) {
            // Check pause/cancel state
            if (task.status === 'error' && task.error === 'Cancelled by user') {
                throw new Error('Cancelled');
            }
            while (task.status === 'paused') {
                await new Promise(r => setTimeout(r, 500));
                if (task.status === 'error') throw new Error('Cancelled');
            }

            const batch = segments.slice(i, i + PARALLEL_THREADS);
            const batchPromises = batch.map(async (segUrl, j) => {
                const index = i + j;
                const segPath = path.join(sessionTempDir, `seg_${index.toString().padStart(5, '0')}.ts`);

                for (let retry = 0; retry < 3; retry++) {
                    try {
                        const bytes = await downloadFile(segUrl, segPath, headers);
                        downloadedBytes += bytes;
                        
                        // Increment individually for smooth UI progress
                        downloadedChunks++;
                        const pct = Math.min((downloadedChunks / segments.length) * 100, 99.9);
                        if (Math.abs(task.progress - pct) > 0.5) {
                            task.progress = pct;
                            broadcastState();
                        }

                        return { path: segPath, bytes, index };
                    } catch (e) {
                        if (retry === 2) throw e;
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
            });

            const results = await Promise.all(batchPromises);
            // Sort by index to maintain correct order in the concat text file
            results.sort((a, b) => a.index - b.index);
            segmentFiles.push(...results.map(r => r.path));
        }

        // 3. Combine with FFmpeg identically to the fast download_server.js logic
        task.status = 'encoding'; // Reusing encoding status for the concatenation phase
        task.progress = 99.9;
        broadcastState();

        const concatFile = path.join(sessionTempDir, `concat.txt`);
        const content = segmentFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
        fs.writeFileSync(concatFile, content);

        const args = [
            '-f', 'concat',
            '-safe', '0',
            '-i', concatFile,
            '-c', 'copy',
            '-bsf:a', 'aac_adtstoasc',
            '-movflags', '+faststart',
            '-y',
            task.outputPath
        ];

        const combineProc = spawn('ffmpeg', args);
        task.process = combineProc;
        
        await new Promise((resolve, reject) => {
            combineProc.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`FFmpeg exit ${code}`));
            });
            combineProc.on('error', reject);
        });

        // Cleanup
        try { fs.rmSync(sessionTempDir, { recursive: true, force: true }); } catch (e) { }

        // Success
        task.status = 'completed';
        task.progress = 100;
        task.process = null;
        activeDownloads--;
        
        setTimeout(() => {
            delete tasks[taskId];
            broadcastState();
        }, 10000);
        
        broadcastState();
        processQueue(); // Try to start next queued items
        
    } catch (e) {
        if (e.message !== 'Cancelled') {
            task.status = 'error';
            task.error = e.message;
        }
        task.process = null;
        activeDownloads--;
        
        const sessionTempDir = path.join(baseDownloadPath, `temp_dl_${taskId}`);
        try { fs.rmSync(sessionTempDir, { recursive: true, force: true }); } catch (e) { }
        
        setTimeout(() => {
            delete tasks[taskId];
            broadcastState();
        }, 10000);
        
        broadcastState();
        processQueue(); // Try to start next queued items
    }
}

// ==== Helper Functions ====
function parseM3U8(content, baseUrl, originalUrl) {
    const lines = content.split('\n');
    let segments = [];
    let totalDuration = 0;
    let lastDuration = 0;

    const urlObj = new URL(originalUrl);

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#EXTINF:')) {
            const match = trimmed.match(/#EXTINF:([0-9.]+)/);
            if (match) lastDuration = parseFloat(match[1]);
        } else if (trimmed && !trimmed.startsWith('#') && !trimmed.endsWith('.m3u8')) {
            const segUrlBase = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
            const segUrl = segUrlBase.includes('?') ? segUrlBase : segUrlBase + urlObj.search;
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
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
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
            agent: isHttps ? httpsAgent : httpAgent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Connection': 'keep-alive',
                ...customHeaders
            }
        };

        const req = client.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadFile(res.headers.location, outputPath, customHeaders).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

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

function bulkCheckDownloaded(videos, quality, mode) {
    const results = {};
    for (const v of videos) {
        const safeTitle = (v.title || `Video_${v.id}`).replace(/[\\/:*?"<>|]/g, '').trim();
        const paths = v.folderPath || [];
        const safePaths = paths.map(p => p.replace(/[\\/:*?"<>|]/g, '').trim());
        const targetDir = path.join(baseDownloadPath, ...safePaths);

        if (mode === 'pdf') {
            const pdfPath = path.join(targetDir, `${safeTitle}.pdf`);
            results[v.id] = fileExistsAndValid(pdfPath);
        } else {
            // Check both with and without quality suffix
            const withQuality = path.join(targetDir, `${safeTitle}_${quality}.mp4`);
            const withoutQuality = path.join(targetDir, `${safeTitle}.mp4`);
            results[v.id] = fileExistsAndValid(withQuality) || fileExistsAndValid(withoutQuality);
        }
    }
    return results;
}

async function downloadPdf(taskId, task) {
    task.status = 'downloading';
    activeDownloads++;
    broadcastState();

    try {
        // Lazy URL resolution for PDFs
        if (!task.url && task.courseId && task.videoId) {
            console.log(`🔗 Fetching fresh PDF URL for ${task.title}...`);
            const videoData = await api.getVideoDetails(task.courseId, task.videoId);
            task.url = videoData.pdf_link_decrypted;
            if (!task.url) throw new Error('No PDF URL available');
        }

        const response = await axios({
            method: 'GET',
            url: task.url,
            responseType: 'stream',
            headers: {
                'Referer': 'https://web.classx.co.in/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
        let downloadedBytes = 0;
        const writer = fs.createWriteStream(task.outputPath);

        response.data.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            if (totalBytes > 0) {
                const pct = Math.min((downloadedBytes / totalBytes) * 100, 99.9);
                if (Math.abs(task.progress - pct) > 1) {
                    task.progress = pct;
                    broadcastState();
                }
            }
        });

        response.data.pipe(writer);

        writer.on('finish', () => {
            task.status = 'completed';
            task.progress = 100;
            task.process = null;
            activeDownloads--;
            setTimeout(() => { delete tasks[taskId]; broadcastState(); }, 10000);
            broadcastState();
            processQueue();
        });

        writer.on('error', (err) => {
            console.error(`PDF download error ${taskId}:`, err.message);
            task.status = 'error';
            task.error = err.message;
            task.process = null;
            activeDownloads--;
            setTimeout(() => { delete tasks[taskId]; broadcastState(); }, 10000);
            broadcastState();
            processQueue();
        });
    } catch (err) {
        console.error(`PDF download failed ${taskId}:`, err.message);
        task.status = 'error';
        task.error = err.message;
        task.process = null;
        activeDownloads--;
        setTimeout(() => { delete tasks[taskId]; broadcastState(); }, 10000);
        broadcastState();
        processQueue();
    }
}



module.exports = {
    init,
    addDownload,
    addPdfDownload,
    pauseAll,
    resumeAll,
    pauseTask,
    resumeTask,
    cancelTask,
    setConcurrency,
    setBasePath,
    getBasePath,
    getQueueState,
    checkSkip,
    checkSkipPdf,
    bulkCheckDownloaded
};
