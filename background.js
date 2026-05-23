// IGNITE Downloader - Background Service Worker v4.1
// VDH-style: Uses download_worker via BroadcastChannel for OPFS + blob URL
// Features: Side panel, 32-thread download, manual capture workflow

const tabStreams = new Map();
const tabUrls = new Map(); // Track tab URLs to detect navigation
let globalStreamId = 0;
let ruleIdCounter = 1000;

// Enable side panel on extension icon click
chrome.sidePanel?.setOptions({ enabled: true });
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {
    // Fallback for older Chrome versions - popup will work instead
    console.log('Side panel behavior not supported, using popup');
});

// Download state persistence
let downloadState = {
    isDownloading: false,
    current: 0,
    total: 0,
    phase: 'idle',
    bytes: 0,
    filename: '',
    startTime: 0,
    lastUpdate: 0
};

async function saveDownloadState() {
    downloadState.lastUpdate = Date.now();
    await chrome.storage.local.set({ downloadState });
}

async function clearDownloadState() {
    downloadState = {
        isDownloading: false,
        current: 0,
        total: 0,
        phase: 'idle',
        bytes: 0,
        filename: '',
        startTime: 0,
        lastUpdate: 0
    };
    await chrome.storage.local.set({ downloadState });
}

// BroadcastChannel for communication with download worker
const downloadChannel = new BroadcastChannel('ignite_download_channel');
let pendingRequests = new Map();
let requestIdCounter = 0;

// Initialize download worker
let workerReady = false;
function initDownloadWorker() {
    // Create worker from extension URL
    const workerUrl = chrome.runtime.getURL('download_worker.js');

    // We can't create Worker directly in service worker, but BroadcastChannel works!
    // The worker is created when the popup opens or via an offscreen document
    sendDebug('Download channel ready');
}

// Send request to worker and wait for response
function workerRequest(type, data) {
    return new Promise((resolve, reject) => {
        const id = ++requestIdCounter;
        const timeout = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error('Worker request timeout'));
        }, 60000); // 60 second timeout

        pendingRequests.set(id, { resolve, reject, timeout });
        downloadChannel.postMessage({ type, id, data });
    });
}

// Handle worker responses
downloadChannel.onmessage = (event) => {
    const { type, id, result } = event.data;
    if (type === 'response') {
        const pending = pendingRequests.get(id);
        if (pending) {
            clearTimeout(pending.timeout);
            pendingRequests.delete(id);
            if (result.success) {
                pending.resolve(result);
            } else {
                pending.reject(new Error(result.error));
            }
        }
    }
};

class StreamInfo {
    constructor(url, tabId, type = 'unknown') {
        this.id = ++globalStreamId;
        this.url = url;
        this.tabId = tabId;
        this.type = type;
        this.timestamp = Date.now();
        this.quality = null;
        this.headers = new Map();
        this.downloadable = true;
        this.ruleIds = [];
    }
}

function sendDebug(msg) {
    chrome.runtime.sendMessage({ action: 'debug', message: msg }).catch(() => { });
    console.log('[DEBUG]', msg);
}

// AES-128-CBC decryption for encrypted file_link
async function decryptFileLink(encryptedLink, encryptionKey) {
    try {
        // Format: "encryptedData:linkIv" and key is "keyBase64:keyIv"
        const [encryptedData, linkIvBase64] = encryptedLink.split(':');
        const [keyBase64, keyIvBase64] = encryptionKey.split(':');

        if (!encryptedData || !keyBase64 || !keyIvBase64) {
            sendDebug(`Invalid format. Link: ${encryptedLink?.substring(0, 30)}, Key: ${encryptionKey}`);
            return null;
        }

        // Decode base64
        const keyBytes = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
        const ivBytes = Uint8Array.from(atob(keyIvBase64), c => c.charCodeAt(0));
        const dataBytes = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0));

        sendDebug(`Key: ${keyBytes.length} bytes, IV: ${ivBytes.length} bytes, Data: ${dataBytes.length} bytes`);

        // Import key for AES-CBC
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'AES-CBC', length: 128 },
            false,
            ['decrypt']
        );

        // Decrypt
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv: ivBytes },
            cryptoKey,
            dataBytes
        );

        // Convert to string
        const decoder = new TextDecoder('utf-8');
        const result = decoder.decode(decrypted);

        return result;
    } catch (error) {
        sendDebug(`Decryption error: ${error.message}`);
        return null;
    }
}

// Open player page in a new tab and capture M3U8 from network
async function openPlayerAndCapture(playerUrl, videoId) {
    return new Promise(async (resolve) => {
        let capturedUrl = null;
        let tabId = null;
        const timeout = 45000; // 45 seconds timeout - needs time for page + video player to load

        // Create a listener for M3U8 requests - specifically from transcoded-videos domain
        const requestListener = (details) => {
            if (details.url.includes('.m3u8') && details.url.includes('transcoded-videos.classx.co.in')) {
                sendDebug(`Captured M3U8 from transcoded-videos: ${details.url.substring(0, 80)}...`);
                if (!capturedUrl) {
                    capturedUrl = details.url;
                }
            } else if (details.tabId === tabId && details.url.includes('.m3u8')) {
                sendDebug(`Captured M3U8 from tab: ${details.url.substring(0, 80)}...`);
                if (!capturedUrl) {
                    capturedUrl = details.url;
                }
            }
        };

        try {
            // Add request listener - include transcoded-videos domain explicitly
            chrome.webRequest.onCompleted.addListener(
                requestListener,
                { urls: ["*://transcoded-videos.classx.co.in/*", "*://*.classx.co.in/*", "*://*.cloudfront.net/*", "*://*.akamai.net.in/*"] }
            );

            // Open the player page - set active: true so user can see it and login if needed
            const tab = await chrome.tabs.create({ url: playerUrl, active: true });
            tabId = tab.id;
            sendDebug(`Opened player tab ${tabId} (active - user may need to login)`);

            // Wait a bit for page initial load
            await new Promise(r => setTimeout(r, 3000));
            sendDebug('Waiting for video player to load and M3U8 to be captured...');

            // Wait for M3U8 to be captured (poll every 500ms)
            const startTime = Date.now();
            while (!capturedUrl && (Date.now() - startTime) < timeout) {
                await new Promise(r => setTimeout(r, 500));

                // Also check tabStreams
                const streams = tabStreams.get(tabId);
                if (streams && streams.length > 0) {
                    capturedUrl = streams[0].url;
                    sendDebug(`Found stream in tabStreams: ${capturedUrl.substring(0, 60)}...`);
                    break;
                }
            }

            // Close the tab
            try {
                await chrome.tabs.remove(tabId);
                sendDebug('Player tab closed');
            } catch (e) { /* Tab might already be closed */ }

            // Remove listener
            chrome.webRequest.onCompleted.removeListener(requestListener);

            resolve(capturedUrl);
        } catch (err) {
            sendDebug(`openPlayerAndCapture error: ${err.message}`);
            chrome.webRequest.onCompleted.removeListener(requestListener);
            if (tabId) {
                try { await chrome.tabs.remove(tabId); } catch (e) { }
            }
            resolve(null);
        }
    });
}

// Capture M3U8 requests
chrome.webRequest.onCompleted.addListener(
    (details) => {
        if (details.tabId < 0) return;
        if (details.statusCode !== 200) return;

        const url = details.url;
        const urlLower = url.toLowerCase();

        if (urlLower.includes('.m3u8') ||
            (urlLower.includes('m3u8') && !urlLower.includes('.ts'))) {
            handleM3U8Detection(url, details.tabId);
        }
    },
    { urls: ["<all_urls>"] }
);

// Capture request headers
chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        if (details.tabId < 0) return;

        const urlLower = details.url.toLowerCase();

        if (urlLower.includes('.m3u8') || urlLower.includes('.ts') || urlLower.includes('.m4s')) {
            const headers = new Map();

            details.requestHeaders?.forEach(h => {
                const name = h.name.toLowerCase();
                if (['cookie', 'referer', 'origin', 'authorization',
                    'x-csrf-token', 'x-auth-token', 'x-requested-with'].includes(name)) {
                    headers.set(h.name, h.value);
                }
            });

            if (headers.size > 0) {
                let streams = tabStreams.get(details.tabId);
                if (streams) {
                    streams.forEach(s => {
                        headers.forEach((value, key) => {
                            s.headers.set(key, value);
                        });
                    });
                    sendDebug(`Captured ${headers.size} headers`);
                }
            }
        }
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders", "extraHeaders"]
);

async function handleM3U8Detection(url, tabId) {
    // Only keep the most recent M3U8 for this tab (not accumulating)
    let streams = tabStreams.get(tabId) || [];

    // Check if this exact URL already exists
    if (streams.find(s => s.url === url)) return;

    // Replace old streams with new one (user wants current video only)
    const stream = new StreamInfo(url, tabId, 'm3u8');
    tabStreams.set(tabId, [stream]); // Replace, don't append

    sendDebug(`M3U8 detected: ${url.substring(0, 60)}...`);
    console.log('[AUTO-SCRAPE] M3U8 detected from tabId:', tabId);

    updateBadge(tabId);
    chrome.runtime.sendMessage({ action: 'streamsUpdated' }).catch(() => { });

    // Notify content script about M3U8 capture (for auto-scrape automation)
    // Send to the specific tab
    chrome.tabs.sendMessage(tabId, {
        action: 'notifyM3U8Captured',
        url: url
    }).catch(() => { });

    // Also send to ALL tabs (iframe might register on different tab)
    chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
            if (tab.id !== tabId) {
                chrome.tabs.sendMessage(tab.id, {
                    action: 'notifyM3U8Captured',
                    url: url
                }).catch(() => { });
            }
        }
    });
}

function updateBadge(tabId) {
    const streams = tabStreams.get(tabId) || [];
    const count = streams.filter(s => s.type === 'm3u8').length;

    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId });
}

// Header modification rules (VDH approach)
async function addHeaderRules(urlPattern, headers) {
    if (headers.size === 0) return [];

    const requestHeaders = [];
    headers.forEach((value, name) => {
        requestHeaders.push({
            operation: 'set',
            header: name,
            value: value
        });
    });

    const ruleIds = [];
    const rules = [];

    const ruleId = ++ruleIdCounter;
    ruleIds.push(ruleId);

    rules.push({
        id: ruleId,
        priority: 1,
        action: {
            type: 'modifyHeaders',
            requestHeaders: requestHeaders
        },
        condition: {
            urlFilter: urlPattern,
            resourceTypes: ['xmlhttprequest', 'media', 'other']
        }
    });

    try {
        await chrome.declarativeNetRequest.updateSessionRules({
            addRules: rules
        });
        sendDebug(`Added ${rules.length} header rules`);
    } catch (err) {
        sendDebug(`Failed to add rules: ${err.message}`);
    }

    return ruleIds;
}

async function removeHeaderRules(ruleIds) {
    if (!ruleIds || ruleIds.length === 0) return;

    try {
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: ruleIds
        });
    } catch (err) {
        console.error('Failed to remove rules:', err);
    }
}

// Parse M3U8
function parseM3U8(content, baseUrl) {
    const lines = content.split('\n');
    const segments = [];
    let currentInit = null;

    if (content.includes('#EXT-X-STREAM-INF')) {
        let bestBandwidth = 0;
        let bestUrl = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('#EXT-X-STREAM-INF')) {
                const bwMatch = line.match(/BANDWIDTH=(\d+)/);
                const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;

                const nextLine = lines[i + 1]?.trim();
                if (nextLine && !nextLine.startsWith('#')) {
                    if (bandwidth > bestBandwidth) {
                        bestBandwidth = bandwidth;
                        bestUrl = nextLine.startsWith('http') ? nextLine : new URL(nextLine, baseUrl).href;
                    }
                }
            }
        }

        return { isMaster: true, variantUrl: bestUrl };
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('#EXT-X-MAP')) {
            const uriMatch = line.match(/URI="([^"]+)"/);
            if (uriMatch) {
                currentInit = uriMatch[1].startsWith('http') ? uriMatch[1] : new URL(uriMatch[1], baseUrl).href;
            }
        }

        if (line.startsWith('#EXTINF')) {
            const nextLine = lines[i + 1]?.trim();
            if (nextLine && !nextLine.startsWith('#') && nextLine.length > 0) {
                const segUrl = nextLine.startsWith('http') ? nextLine : new URL(nextLine, baseUrl).href;
                segments.push({
                    url: segUrl,
                    init: currentInit,
                    index: segments.length
                });
            }
        }
    }

    return { isMaster: false, segments };
}

// ============ SERVER-SIDE DOWNLOAD (FFmpeg) ============
// Try to download via local Node.js server for better memory efficiency
const SERVER_URL = 'http://localhost:3003';

async function downloadViaServer(m3u8Url, folderPath, filename, headers = {}) {
    try {
        sendDebug(`Trying server download: ${filename}`);

        // Convert headers Map to plain object if needed
        const headerObj = {};
        if (headers instanceof Map) {
            headers.forEach((v, k) => headerObj[k] = v);
        } else if (headers && typeof headers === 'object') {
            Object.assign(headerObj, headers);
        }

        const response = await fetch(`${SERVER_URL}/api/extension-download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                m3u8Url,
                folderPath: folderPath || '',
                filename: filename || 'video',
                headers: headerObj
            })
        });

        if (!response.ok) {
            throw new Error(`Server returned ${response.status}`);
        }

        const result = await response.json();
        if (result.success) {
            sendDebug(`✅ Server accepted download: ${filename}`);
            return { success: true, serverSide: true, message: 'Download started on server. Check server logs for progress.' };
        } else {
            throw new Error(result.error || 'Server download failed');
        }
    } catch (e) {
        sendDebug(`⚠️ Server unavailable (${e.message}), using in-browser download`);
        return { success: false, message: e.message };
    }
}

// Download HLS - VDH style with worker
async function downloadHLS(streamId, tabId, outputName = 'ignite_video') {
    const streams = tabStreams.get(tabId) || [];
    const stream = streams.find(s => s.id === streamId);

    if (!stream) {
        sendDebug('Stream not found');
        return { success: false, message: 'Stream not found. Refresh and try again.' };
    }

    // Set download state at start
    downloadState.isDownloading = true;
    downloadState.filename = `${outputName}.mp4`;
    downloadState.startTime = Date.now();
    downloadState.phase = 'starting';
    downloadState.current = 0;
    downloadState.total = 0;
    downloadState.bytes = 0;
    saveDownloadState();

    sendDebug(`Starting download: ${stream.url.substring(0, 60)}...`);
    sendDebug(`Headers available: ${stream.headers.size}`);

    const baseUrl = new URL('.', stream.url).href;
    const urlPattern = baseUrl + '*';
    const ruleIds = await addHeaderRules(urlPattern, stream.headers);

    try {
        // Fetch and parse M3U8
        let m3u8Url = stream.url;
        let segments = [];
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            attempts++;
            sendDebug(`Fetching M3U8 (attempt ${attempts}): ${m3u8Url.substring(0, 50)}...`);

            const response = await fetch(m3u8Url, { credentials: 'include' });
            if (!response.ok) {
                return { success: false, message: `Failed to fetch M3U8: HTTP ${response.status}` };
            }

            const content = await response.text();
            const currentBase = new URL('.', m3u8Url).href;
            const parsed = parseM3U8(content, currentBase);

            if (parsed.isMaster && parsed.variantUrl) {
                sendDebug(`Master playlist -> ${parsed.variantUrl.substring(0, 50)}...`);
                m3u8Url = parsed.variantUrl;

                const newBase = new URL('.', m3u8Url).href;
                if (newBase !== baseUrl) {
                    const newRules = await addHeaderRules(newBase + '*', stream.headers);
                    ruleIds.push(...newRules);
                }
            } else {
                segments = parsed.segments;
                break;
            }
        }

        sendDebug(`Found ${segments.length} segments`);

        // TRY SERVER-SIDE DOWNLOAD FIRST (uses ffmpeg, no browser memory issues)
        // The server will download segments to temp and combine with ffmpeg
        const serverResult = await downloadViaServer(m3u8Url, outputName.includes('/') ? outputName.substring(0, outputName.lastIndexOf('/')) : '',
            outputName.includes('/') ? outputName.substring(outputName.lastIndexOf('/') + 1) : outputName,
            stream.headers);

        if (serverResult.success && serverResult.serverSide) {
            // Server accepted the download, clean up and return
            await removeHeaderRules(ruleIds);
            clearDownloadState();
            return {
                success: true,
                serverSide: true,
                message: 'Download started on Node.js server. Check server logs (http://localhost:3002) for progress.',
                filename: `${outputName}.mp4`
            };
        }

        // Server unavailable - fall back to in-browser download
        sendDebug('Using in-browser download (server unavailable)');

        // Use in-memory download (independent of popup - works in background)
        // This approach doesn't depend on the download worker
        return await downloadHLSInMemory(stream, segments, outputName, ruleIds);

        let totalBytes = 0;
        let successCount = 0;
        let failedCount = 0;
        let firstError = null;
        let isFMP4 = false; // Will detect from init segment or first segment

        // Download init segment (indicates fMP4 format)
        if (segments[0]?.init) {
            try {
                sendDebug(`Fetching init segment (fMP4 format)...`);
                const initResp = await fetch(segments[0].init, { credentials: 'include' });
                if (initResp.ok) {
                    const initData = await initResp.arrayBuffer();
                    await workerRequest('write', { filename, chunk: initData });
                    totalBytes += initData.byteLength;
                    sendDebug(`Init segment: ${initData.byteLength} bytes`);

                    // Presence of init segment = fMP4 format
                    const view = new Uint8Array(initData);
                    if (view.length > 7 && view[4] === 0x66 && view[5] === 0x74 &&
                        view[6] === 0x79 && view[7] === 0x70) {
                        isFMP4 = true;
                        sendDebug('Detected fMP4 format (proper MP4 container)');
                    }
                }
            } catch (e) {
                sendDebug(`Init segment failed: ${e.message}`);
            }
        }

        // Download segments
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];

            try {
                const response = await fetch(seg.url, { credentials: 'include' });

                if (!response.ok) {
                    failedCount++;
                    if (!firstError) firstError = `Segment ${i}: HTTP ${response.status}`;
                    continue;
                }

                const data = await response.arrayBuffer();

                // Detect format from first segment if no init segment
                if (i === 0 && !isFMP4) {
                    const view = new Uint8Array(data);
                    // Check for MPEG-TS sync byte (0x47)
                    if (view[0] === 0x47) {
                        sendDebug('Detected MPEG-TS format (.ts)');
                    }
                    // Check for fMP4 moof box
                    else if (view.length > 7 && view[4] === 0x6D && view[5] === 0x6F &&
                        view[6] === 0x6F && view[7] === 0x66) {
                        isFMP4 = true;
                        sendDebug('Detected fMP4 segment format');
                    }
                }

                await workerRequest('write', { filename, chunk: data });
                totalBytes += data.byteLength;
                successCount++;

                if (i % 20 === 0 || i === segments.length - 1) {
                    // Update and persist download state
                    downloadState.current = i + 1;
                    downloadState.total = segments.length;
                    downloadState.phase = 'downloading';
                    downloadState.bytes = totalBytes;
                    saveDownloadState();

                    chrome.runtime.sendMessage({
                        action: 'downloadProgress',
                        current: i + 1,
                        total: segments.length,
                        phase: 'downloading',
                        bytes: totalBytes
                    }).catch(() => { });
                    sendDebug(`Progress: ${i + 1}/${segments.length} - ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
                }

            } catch (err) {
                failedCount++;
                if (!firstError) firstError = `Segment ${i}: ${err.message}`;
            }
        }

        if (successCount === 0) {
            await workerRequest('remove', { filename });
            return { success: false, message: `All segments failed! ${firstError}` };
        }

        // Close file and get blob URL from worker
        sendDebug(`Closing OPFS file...`);
        await workerRequest('close', { filename });

        // Output as MP4 (works for both fMP4 and TS with modern players)
        const finalFilename = `${outputName}.mp4`;
        sendDebug(`Format detected: ${isFMP4 ? 'fMP4' : 'MPEG-TS'}, saving as: ${finalFilename}`);

        sendDebug(`Creating blob URL...`);
        const blobResult = await workerRequest('createBlobUrl', { filename, mimeType: 'video/mp4' });
        const blobUrl = blobResult.blobUrl;

        sendDebug(`Starting download: ${finalFilename}`);

        return new Promise((resolve) => {
            chrome.downloads.download({
                url: blobUrl,
                filename: finalFilename,
                conflictAction: 'uniquify',
                saveAs: false
            }, async (downloadId) => {
                const cleanup = async () => {
                    try {
                        await workerRequest('revokeBlobUrl', { blobUrl });
                        await workerRequest('remove', { filename });
                    } catch (e) { }
                };

                if (chrome.runtime.lastError || !downloadId) {
                    sendDebug(`Download error: ${chrome.runtime.lastError?.message}`);
                    await cleanup();
                    resolve({
                        success: false,
                        message: 'Download failed: ' + (chrome.runtime.lastError?.message || 'Unknown')
                    });
                    return;
                }

                sendDebug(`Download started: ID ${downloadId}`);

                chrome.downloads.onChanged.addListener(async function handler(delta) {
                    if (delta.id === downloadId) {
                        if (delta.state?.current === 'complete') {
                            sendDebug('Download complete!');
                            // Mark download as complete in state
                            downloadState.isDownloading = false;
                            downloadState.phase = 'complete';
                            saveDownloadState();
                            await cleanup();
                            chrome.downloads.onChanged.removeListener(handler);
                        } else if (delta.state?.current === 'interrupted') {
                            downloadState.isDownloading = false;
                            downloadState.phase = 'failed';
                            saveDownloadState();
                            await cleanup();
                            chrome.downloads.onChanged.removeListener(handler);
                        }
                    }
                });

                resolve({
                    success: true,
                    downloaded: successCount,
                    total: segments.length,
                    failed: failedCount,
                    fileSize: totalBytes,
                    filename: finalFilename
                });
            });
        });

    } finally {
        await removeHeaderRules(ruleIds);
    }
}

// In-memory download approach (works in background, no popup dependency)
async function downloadHLSInMemory(stream, segments, outputName, ruleIds) {
    sendDebug('Using in-memory download (no worker dependency)...');

    const chunks = [];
    let totalBytes = 0;
    let successCount = 0;
    let failedCount = 0;
    let firstError = null;
    let isFMP4 = false;

    // Download init segment
    if (segments[0]?.init) {
        try {
            sendDebug('Fetching init segment...');
            const initResp = await fetch(segments[0].init, { credentials: 'include' });
            if (initResp.ok) {
                const initData = await initResp.arrayBuffer();
                const initBytes = new Uint8Array(initData);
                chunks.push(initBytes);
                totalBytes += initData.byteLength;

                // Detect fMP4
                if (initBytes.length > 7 && initBytes[4] === 0x66 && initBytes[5] === 0x74 &&
                    initBytes[6] === 0x79 && initBytes[7] === 0x70) {
                    isFMP4 = true;
                    sendDebug('Detected fMP4 format');
                }
            }
        } catch (e) {
            sendDebug(`Init segment failed: ${e.message}`);
        }
    }

    // Download segments - 32 parallel threads
    const PARALLEL_THREADS = 32;
    sendDebug(`Downloading ${segments.length} segments with ${PARALLEL_THREADS} parallel threads...`);

    // Pre-allocate results array to maintain order
    const results = new Array(segments.length).fill(null);
    let completedCount = 0;

    // Function to download a single segment
    const downloadSegment = async (index) => {
        try {
            const response = await fetch(segments[index].url, { credentials: 'include' });

            if (!response.ok) {
                failedCount++;
                if (!firstError) firstError = `Segment ${index}: HTTP ${response.status}`;
                return null;
            }

            const data = await response.arrayBuffer();
            const bytes = new Uint8Array(data);

            // Detect format from first segment
            if (index === 0 && !isFMP4) {
                if (bytes[0] === 0x47) {
                    sendDebug('Detected MPEG-TS format');
                } else if (bytes.length > 7 && bytes[4] === 0x6D && bytes[5] === 0x6F) {
                    isFMP4 = true;
                    sendDebug('Detected fMP4 segment');
                }
            }

            results[index] = bytes;
            totalBytes += data.byteLength;
            successCount++;
            completedCount++;

            return bytes;
        } catch (err) {
            failedCount++;
            if (!firstError) firstError = `Segment ${index}: ${err.message}`;
            completedCount++;
            return null;
        }
    };

    // Process segments in batches of PARALLEL_THREADS
    for (let batchStart = 0; batchStart < segments.length; batchStart += PARALLEL_THREADS) {
        const batchEnd = Math.min(batchStart + PARALLEL_THREADS, segments.length);
        const batchPromises = [];

        // Start all fetches in this batch
        for (let i = batchStart; i < batchEnd; i++) {
            batchPromises.push(downloadSegment(i));
        }

        // Wait for all in batch to complete
        await Promise.all(batchPromises);

        // Update progress after each batch
        downloadState.current = completedCount;
        downloadState.total = segments.length;
        downloadState.phase = 'downloading';
        downloadState.bytes = totalBytes;
        saveDownloadState();

        chrome.runtime.sendMessage({
            action: 'downloadProgress',
            current: completedCount,
            total: segments.length,
            phase: 'downloading',
            bytes: totalBytes
        }).catch(() => { });

        sendDebug(`Progress: ${completedCount}/${segments.length} - ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
    }

    // Collect valid segments in order
    for (let i = 0; i < results.length; i++) {
        if (results[i]) {
            chunks.push(results[i]);
        }
    }

    await removeHeaderRules(ruleIds);

    if (successCount === 0) {
        downloadState.isDownloading = false;
        downloadState.phase = 'failed';
        saveDownloadState();
        return { success: false, message: `All segments failed! ${firstError}` };
    }

    // Always save as MP4 with video/mp4 mime type
    const filename = `${outputName}.mp4`;

    sendDebug(`Creating download for ${(totalBytes / 1024 / 1024).toFixed(1)} MB file...`);

    // For large files, use OPFS worker approach
    // For smaller files (<50MB), use direct blob approach
    const USE_WORKER_THRESHOLD = 50 * 1024 * 1024; // 50MB

    if (totalBytes > USE_WORKER_THRESHOLD && workerReady) {
        // Use OPFS worker for large files
        try {
            sendDebug('Using OPFS worker for large file...');
            const tempFilename = `temp_${Date.now()}.mp4`;

            // Open file in OPFS
            await workerRequest('open', { filename: tempFilename });

            // Write chunks
            for (let i = 0; i < chunks.length; i++) {
                await workerRequest('write', { filename: tempFilename, chunk: chunks[i].buffer });
            }

            // Close and get blob URL
            await workerRequest('close', { filename: tempFilename });
            const blobResult = await workerRequest('createBlobUrl', { filename: tempFilename, mimeType: 'video/mp4' });

            if (!blobResult.success || !blobResult.blobUrl) {
                throw new Error('Failed to create blob URL from worker');
            }

            // Download using blob URL
            return new Promise((resolve) => {
                chrome.downloads.download({
                    url: blobResult.blobUrl,
                    filename: filename,
                    conflictAction: 'uniquify',
                    saveAs: false
                }, async (downloadId) => {
                    // Clean up
                    await workerRequest('revokeBlobUrl', { blobUrl: blobResult.blobUrl });
                    await workerRequest('remove', { filename: tempFilename });

                    if (chrome.runtime.lastError || !downloadId) {
                        downloadState.isDownloading = false;
                        downloadState.phase = 'failed';
                        saveDownloadState();
                        resolve({ success: false, message: 'Download failed: ' + (chrome.runtime.lastError?.message || 'Unknown') });
                        return;
                    }

                    sendDebug(`Download started: ID ${downloadId}`);
                    downloadState.isDownloading = false;
                    downloadState.phase = 'complete';
                    downloadState.filename = filename;
                    saveDownloadState();

                    resolve({
                        success: true,
                        downloaded: successCount,
                        total: segments.length,
                        failed: failedCount,
                        fileSize: totalBytes,
                        filename: filename
                    });
                });
            });
        } catch (workerError) {
            sendDebug(`Worker approach failed: ${workerError.message}, falling back to direct download`);
        }
    }

    // Direct approach for smaller files - create blob and download in chunks
    sendDebug('Using direct blob download...');
    const blob = new Blob(chunks, { type: 'video/mp4' });

    // Clear chunks array to free memory
    chunks.length = 0;

    // Use blob: URL via an anchor element approach wouldn't work in service worker
    // Instead, read blob in smaller chunks for data URL if needed
    return new Promise((resolve) => {
        // For files under 50MB, data URL is usually fine
        const reader = new FileReader();
        reader.onload = () => {
            // Clear blob reference
            const dataUrl = reader.result;

            chrome.downloads.download({
                url: dataUrl,
                filename: filename,
                conflictAction: 'uniquify',
                saveAs: false
            }, (downloadId) => {
                if (chrome.runtime.lastError || !downloadId) {
                    downloadState.isDownloading = false;
                    downloadState.phase = 'failed';
                    saveDownloadState();
                    resolve({ success: false, message: 'Download failed: ' + (chrome.runtime.lastError?.message || 'Unknown') });
                    return;
                }

                sendDebug(`Download started: ID ${downloadId}`);
                downloadState.isDownloading = false;
                downloadState.phase = 'complete';
                downloadState.filename = filename;
                saveDownloadState();

                resolve({
                    success: true,
                    downloaded: successCount,
                    total: segments.length,
                    failed: failedCount,
                    fileSize: totalBytes,
                    filename: filename
                });
            });
        };
        reader.onerror = () => {
            downloadState.isDownloading = false;
            downloadState.phase = 'failed';
            saveDownloadState();
            resolve({ success: false, message: 'Failed to create data URL' });
        };
        reader.readAsDataURL(blob);
    });
}


// Message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case 'getStreams': {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const activeTabId = tabs[0]?.id;
                const streams = tabStreams.get(activeTabId) || [];

                const result = streams
                    .filter(s => s.type === 'm3u8')
                    .map(s => ({
                        id: s.id,
                        url: s.url,
                        type: 'm3u8',
                        quality: 'Auto (best)',
                        downloadable: true,
                        headersCount: s.headers.size
                    }));

                sendResponse({
                    streams: result,
                    tabId: activeTabId
                });
            });
            return true;
        }

        case 'download': {
            chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
                const activeTabId = tabs[0]?.id;
                sendDebug(`Download requested for stream ${request.streamId}`);

                const result = await downloadHLS(
                    request.streamId,
                    activeTabId,
                    request.outputName || 'ignite_video'
                );

                sendResponse(result);
            });
            return true;
        }

        case 'workerReady': {
            workerReady = true;
            sendDebug('Download worker is ready');
            sendResponse({ success: true });
            return true;
        }

        case 'getM3U8Url': {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const activeTabId = tabs[0]?.id;
                const streams = tabStreams.get(activeTabId) || [];
                const m3u8 = streams.find(s => s.type === 'm3u8');
                sendResponse({ url: m3u8?.url || null });
            });
            return true;
        }

        case 'clear': {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const activeTabId = tabs[0]?.id;
                tabStreams.delete(activeTabId);
                updateBadge(activeTabId);
                sendDebug('Cleared streams');
                sendResponse({ success: true });
            });
            return true;
        }

        case 'clearStream': {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const activeTabId = tabs[0]?.id;
                const streams = tabStreams.get(activeTabId) || [];
                const filtered = streams.filter(s => s.id !== request.streamId);
                tabStreams.set(activeTabId, filtered);
                updateBadge(activeTabId);
                sendDebug(`Cleared stream ${request.streamId}, ${filtered.length} remaining`);
                sendResponse({ success: true });
            });
            return true;
        }

        case 'autoDownload': {
            // Auto-download triggered by auto-scrape - download current stream with given name
            console.log('[AUTO-DOWNLOAD] Received request:', request);

            chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
                const activeTabId = tabs[0]?.id;
                console.log('[AUTO-DOWNLOAD] Active tab ID:', activeTabId);
                console.log('[AUTO-DOWNLOAD] All tabStreams:', [...tabStreams.entries()]);

                let streams = tabStreams.get(activeTabId) || [];

                // If no streams in current tab, check all tabs (iframe might have different ID)
                if (streams.length === 0) {
                    console.log('[AUTO-DOWNLOAD] No streams in current tab, checking all tabs...');
                    for (const [tabId, tabStreamList] of tabStreams.entries()) {
                        if (tabStreamList.length > 0) {
                            console.log('[AUTO-DOWNLOAD] Found streams in tab', tabId);
                            streams = tabStreamList;
                            break;
                        }
                    }
                }

                if (streams.length === 0) {
                    console.error('[AUTO-DOWNLOAD] No streams available in any tab!');
                    sendDebug('[AUTO-DOWNLOAD] No streams available');
                    sendResponse({ success: false, message: 'No streams' });
                    return;
                }

                const stream = streams[0];
                const videoName = request.videoName || 'ignite_video';
                const folderPath = request.folderPath || '';

                // Build output name with folder path
                const outputName = folderPath
                    ? `${folderPath}/${videoName}`
                    : videoName;

                console.log('[AUTO-DOWNLOAD] Starting download:', outputName, 'URL:', stream.url?.substring(0, 60));
                sendDebug(`[AUTO-DOWNLOAD] Starting: ${outputName}`);

                try {
                    const downloadResponse = await fetch('http://localhost:3003/api/download', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            url: stream.url,
                            outputName: outputName,
                            folderPath: folderPath
                        })
                    });

                    const result = await downloadResponse.json();
                    console.log('[AUTO-DOWNLOAD] Server response:', result);

                    if (result.success) {
                        sendDebug(`[AUTO-DOWNLOAD] Queued: ${outputName}`);
                        // Clear the stream after queuing from all tabs
                        for (const [tabId, tabStreamList] of tabStreams.entries()) {
                            const filtered = tabStreamList.filter(s => s.id !== stream.id);
                            tabStreams.set(tabId, filtered);
                            updateBadge(tabId);
                        }
                        sendResponse({ success: true, message: 'Download queued' });
                    } else {
                        console.error('[AUTO-DOWNLOAD] Failed:', result.error);
                        sendDebug(`[AUTO-DOWNLOAD] Failed: ${result.error}`);
                        sendResponse({ success: false, message: result.error });
                    }
                } catch (error) {
                    console.error('[AUTO-DOWNLOAD] Error:', error);
                    sendDebug(`[AUTO-DOWNLOAD] Error: ${error.message}`);
                    sendResponse({ success: false, message: error.message });
                }
            });
            return true;
        }

        case 'refresh': {
            sendResponse({ success: true });
            return true;
        }

        case 'getDownloadState': {
            // Return current download state for popup restoration
            chrome.storage.local.get(['downloadState'], (result) => {
                sendResponse(result.downloadState || downloadState);
            });
            return true;
        }

        // ============ CONFIG HANDLERS ============
        case 'getConfig': {
            chrome.storage.local.get(['igniteConfig'], (result) => {
                sendResponse(result.igniteConfig || {});
            });
            return true;
        }

        case 'saveConfig': {
            chrome.storage.local.set({ igniteConfig: request.config }, () => {
                sendDebug('Config saved');
                sendResponse({ success: true });
            });
            return true;
        }

        case 'testConfig': {
            (async () => {
                try {
                    const result = await chrome.storage.local.get(['igniteConfig']);
                    const config = result.igniteConfig || {};

                    if (!config.authorization) {
                        sendResponse({ success: false, error: 'No authorization token' });
                        return;
                    }

                    const apiUrl = `${config.apiBase || 'https://ignite247api.classx.co.in'}/get/folder_contentsv3?course_id=${config.courseId || '673'}&parent_id=-1&windowsapp=true&start=0`;

                    const response = await fetch(apiUrl, {
                        headers: {
                            'authorization': config.authorization,
                            'user-id': config.userId || '',
                            'auth-key': 'appxapi',
                            'client-service': 'ignite247',
                            'source': 'website'
                        }
                    });

                    const data = await response.json();
                    if (data.status === 200 && data.data) {
                        sendResponse({ success: true, count: data.data.length });
                    } else {
                        sendResponse({ success: false, error: data.message || 'API error' });
                    }
                } catch (e) {
                    sendResponse({ success: false, error: e.message });
                }
            })();
            return true;
        }

        // ============ FOLDER BROWSING HANDLERS ============
        case 'loadFolder': {
            (async () => {
                try {
                    const result = await chrome.storage.local.get(['igniteConfig']);
                    const config = result.igniteConfig || {};

                    if (!config.authorization) {
                        sendResponse({ error: 'Not configured. Go to Settings tab.' });
                        return;
                    }

                    const folderId = request.folderId || '-1';
                    const apiUrl = `${config.apiBase || 'https://ignite247api.classx.co.in'}/get/folder_contentsv3?course_id=${config.courseId || '673'}&parent_id=${folderId}&windowsapp=true&start=0`;

                    sendDebug(`Loading folder ${folderId}...`);

                    const response = await fetch(apiUrl, {
                        headers: {
                            'authorization': config.authorization,
                            'user-id': config.userId || '',
                            'auth-key': 'appxapi',
                            'client-service': 'ignite247',
                            'source': 'website'
                        }
                    });

                    const data = await response.json();

                    if (data.status !== 200 || !data.data) {
                        sendResponse({ error: data.message || 'API returned error' });
                        return;
                    }

                    const items = data.data || [];
                    const folders = items.filter(i => i.material_type === 'FOLDER').map(f => ({
                        id: f.id,
                        title: f.Title
                    }));
                    const videos = items.filter(i => i.material_type === 'VIDEO').map(v => ({
                        id: v.id,
                        title: v.Title,
                        duration: v.duration || ''
                    }));

                    sendResponse({ folders, videos, folderId });

                } catch (e) {
                    sendDebug(`Folder load error: ${e.message}`);
                    sendResponse({ error: e.message });
                }
            })();
            return true;
        }

        // ============ VIDEO DOWNLOAD FROM API ============
        case 'downloadVideo': {
            (async () => {
                try {
                    const result = await chrome.storage.local.get(['igniteConfig']);
                    const config = result.igniteConfig || {};

                    if (!config.authorization) {
                        sendResponse({ success: false, message: 'Not configured' });
                        return;
                    }

                    const videoId = request.videoId;
                    const videoTitle = request.videoTitle || 'video';
                    const folderPath = request.folderPath || '';
                    const safeTitle = videoTitle.replace(/[<>:"/\\|?*]/g, '_').substring(0, 80);

                    // Build output path with folder structure
                    const outputPath = folderPath ? `${folderPath}/${safeTitle}` : safeTitle;

                    sendDebug(`Fetching video details for ${videoId}...`);

                    // 1. Fetch video details to get player token
                    const detailsUrl = `${config.apiBase || 'https://ignite247api.classx.co.in'}/get/fetchVideoDetailsById?course_id=${config.courseId || '673'}&video_id=${videoId}&ytflag=0&folder_wise_course=1`;

                    const detailsResponse = await fetch(detailsUrl, {
                        headers: {
                            'authorization': config.authorization,
                            'user-id': config.userId || '',
                            'auth-key': 'appxapi',
                            'client-service': 'ignite247',
                            'source': 'website'
                        }
                    });

                    const detailsData = await detailsResponse.json();
                    sendDebug(`Video details response: ${JSON.stringify(detailsData).substring(0, 200)}`);

                    if (detailsData.status !== 200 || !detailsData.data) {
                        sendResponse({ success: false, message: `API error: ${detailsData.message || 'Unknown'}` });
                        return;
                    }

                    const videoDetails = detailsData.data;
                    sendDebug(`Keys: ${Object.keys(videoDetails).join(', ')}`);

                    // Try to find M3U8 URL from various possible fields
                    let m3u8Url = null;

                    // 1. Check for direct M3U8 URLs
                    if (videoDetails.video_url && videoDetails.video_url.includes('.m3u8')) {
                        m3u8Url = videoDetails.video_url;
                        sendDebug('Found M3U8 in video_url');
                    }
                    else if (videoDetails.download_link && videoDetails.download_link.includes('.m3u8')) {
                        m3u8Url = videoDetails.download_link;
                        sendDebug('Found M3U8 in download_link');
                    }
                    else if (videoDetails.hls_url) {
                        m3u8Url = videoDetails.hls_url;
                        sendDebug('Found M3U8 in hls_url');
                    }
                    // 2. Try webdrm_links array
                    else if (videoDetails.webdrm_links && Array.isArray(videoDetails.webdrm_links)) {
                        sendDebug(`webdrm_links has ${videoDetails.webdrm_links.length} items`);
                        for (const link of videoDetails.webdrm_links) {
                            if (link.url && link.url.includes('.m3u8')) {
                                m3u8Url = link.url;
                                sendDebug(`Found M3U8 in webdrm_links: ${m3u8Url.substring(0, 60)}...`);
                                break;
                            }
                        }
                    }
                    // 3. Try file_link with decryption
                    else if (videoDetails.file_link && videoDetails.video_key) {
                        sendDebug('Attempting file_link decryption...');
                        try {
                            const decryptedUrl = await decryptFileLink(videoDetails.file_link, videoDetails.video_key);
                            if (decryptedUrl && decryptedUrl.startsWith('http')) {
                                m3u8Url = decryptedUrl;
                                sendDebug(`Decrypted URL: ${m3u8Url.substring(0, 60)}...`);
                            } else {
                                sendDebug(`Decryption result: ${decryptedUrl?.substring(0, 100) || 'null'}`);
                            }
                        } catch (decryptErr) {
                            sendDebug(`Decryption failed: ${decryptErr.message}`);
                        }
                    }
                    // 4. Try encrypted_links object
                    else if (videoDetails.encrypted_links) {
                        sendDebug(`encrypted_links: ${JSON.stringify(videoDetails.encrypted_links).substring(0, 200)}`);
                        // Try to find HLS link in encrypted_links
                        if (videoDetails.encrypted_links.hls) {
                            try {
                                const decryptedUrl = await decryptFileLink(videoDetails.encrypted_links.hls, videoDetails.video_key);
                                if (decryptedUrl && decryptedUrl.startsWith('http')) {
                                    m3u8Url = decryptedUrl;
                                    sendDebug(`Decrypted encrypted_links.hls: ${m3u8Url.substring(0, 60)}...`);
                                }
                            } catch (e) {
                                sendDebug(`encrypted_links.hls decryption failed: ${e.message}`);
                            }
                        }
                    }
                    // 5. Build from player token if available
                    else if (videoDetails.video_player_token) {
                        const token = videoDetails.video_player_token;
                        m3u8Url = `https://d26g5bnklkwsh4.cloudfront.net/${token}/master.m3u8`;
                        sendDebug(`Constructed M3U8 from token: ${m3u8Url.substring(0, 60)}...`);
                    }

                    if (!m3u8Url) {
                        // Cannot get M3U8 directly - need manual capture
                        sendDebug('No direct M3U8 available. Manual capture required.');

                        const courseId = config.courseId || '673';
                        const playerUrl = `https://igjhvhsdgavf.akamai.net.in/new-courses/${courseId}/content?activeTab=Content`;

                        sendDebug(`Video not downloadable via API. Navigate to player and play the video manually.`);
                        sendDebug(`Player URL: ${playerUrl}`);

                        sendResponse({
                            success: false,
                            message: `Manual capture needed. Go to Ignite247, play "${safeTitle.substring(0, 30)}...", then use Streams tab.`,
                            requiresManualCapture: true,
                            playerUrl: playerUrl,
                            videoTitle: safeTitle
                        });
                        return;
                    }

                    sendDebug(`M3U8 URL: ${m3u8Url.substring(0, 60)}...`);

                    // Create stream and download
                    const tempStream = new StreamInfo(m3u8Url, -1, 'm3u8');

                    // Add cookie if available
                    if (videoDetails.cookie_key && videoDetails.cookie_value) {
                        tempStream.headers.set('Cookie', `${videoDetails.cookie_key}=${videoDetails.cookie_value}`);
                    }

                    // Store temporarily
                    const tempTabId = -100 - parseInt(videoId);
                    tabStreams.set(tempTabId, [tempStream]);

                    // Use existing download flow with folder structure in path
                    const downloadResult = await downloadHLS(tempStream.id, tempTabId, outputPath);

                    // Cleanup
                    tabStreams.delete(tempTabId);

                    sendResponse(downloadResult);

                } catch (e) {
                    sendDebug(`Video download error: ${e.message}`);
                    sendResponse({ success: false, message: e.message });
                }
            })();
            return true;
        }
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    tabStreams.delete(tabId);
    tabUrls.delete(tabId);
});

// Clear streams when tab URL changes (user navigates to different video)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
        const oldUrl = tabUrls.get(tabId);
        if (oldUrl && oldUrl !== changeInfo.url) {
            // URL changed - clear old streams
            tabStreams.delete(tabId);
            updateBadge(tabId);
            sendDebug('Tab navigated, cleared old streams');
        }
        tabUrls.set(tabId, changeInfo.url);
    }
});

initDownloadWorker();
console.log('âœ… IGNITE HLS Downloader v3.1 - VDH-style + navigation handling');
