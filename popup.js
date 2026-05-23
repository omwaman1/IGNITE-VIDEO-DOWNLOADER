// IGNITE Downloader - Popup Script v4.2
// Features: Tab navigation, folder browsing for path selection, single stream download with folder path

let debugLog = [];
let folderPaths = new Map(); // Track folder paths: folderId -> full path string
let currentFolderPath = ''; // Currently selected folder path for downloads
let currentFolderVideos = []; // Videos in current selected folder
let videoIndex = 0; // Current index for auto-naming videos

// ============ DEBUG ============
function addDebug(msg) {
    const time = new Date().toLocaleTimeString();
    debugLog.push(`[${time}] ${msg}`);
    if (debugLog.length > 100) debugLog.shift();
    updateDebugPanel();
    console.log('[IGNITE]', msg);
}

function updateDebugPanel() {
    const panel = document.getElementById('debugLog');
    if (panel) {
        panel.innerHTML = debugLog.slice(-20).map(m => `<div>${m}</div>`).join('');
        panel.scrollTop = panel.scrollHeight;
    }
}

// ============ INITIALIZATION ============
document.addEventListener('DOMContentLoaded', () => {
    addDebug('Popup loaded v4.1');

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Streams tab buttons
    document.getElementById('downloadBtn').addEventListener('click', startStreamDownload);
    document.getElementById('refreshBtn').addEventListener('click', refreshPlaylist);
    document.getElementById('copyBtn').addEventListener('click', copyM3U8);
    document.getElementById('clearBtn').addEventListener('click', clearAll);
    document.getElementById('resetIndexBtn')?.addEventListener('click', resetVideoIndex);

    // Auto-scrape buttons
    document.getElementById('startAutoScrapeBtn')?.addEventListener('click', startAutoScrape);
    document.getElementById('stopAutoScrapeBtn')?.addEventListener('click', stopAutoScrape);

    // Browse tab button
    document.getElementById('loadRootBtn').addEventListener('click', loadRootFolders);

    // Settings tab buttons
    document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);
    document.getElementById('testConfigBtn').addEventListener('click', testConfig);

    // Debug tab button
    document.getElementById('clearDebugBtn')?.addEventListener('click', () => {
        debugLog = [];
        updateDebugPanel();
    });

    // Load saved config and streams
    loadConfig();
    loadStreams();
    loadSavedFolderPath();

    // Auto-refresh streams and server status
    setInterval(loadStreams, 2000);
    setInterval(updateServerStatus, 1000);
    updateServerStatus(); // Initial fetch

    // Listen for auto-scrape status updates from content script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'autoScrapeStatus') {
            updateAutoScrapeUI(request);
        }
    });
});

// Update auto-scrape UI based on status
function updateAutoScrapeUI(data) {
    const startBtn = document.getElementById('startAutoScrapeBtn');
    const stopBtn = document.getElementById('stopAutoScrapeBtn');
    const statusEl = document.getElementById('autoScrapeStatus');

    if (!statusEl) return;

    statusEl.textContent = data.message;

    if (data.type === 'progress') {
        statusEl.style.color = '#54a0ff';
        // Update our local index to match
        videoIndex = data.currentIndex;
        updateIndexDisplay();
    } else if (data.type === 'complete') {
        statusEl.style.color = '#81c784';
        startBtn.style.display = 'inline-block';
        stopBtn.style.display = 'none';
    } else if (data.type === 'error') {
        statusEl.style.color = '#f66';
        startBtn.style.display = 'inline-block';
        stopBtn.style.display = 'none';
    } else if (data.type === 'stopped') {
        statusEl.style.color = '#888';
        startBtn.style.display = 'inline-block';
        stopBtn.style.display = 'none';
    }

    addDebug(`Auto-scrape: ${data.message}`);
}

// ============ SERVER STATUS ============
const SERVER_URL = 'http://localhost:3003';

async function updateServerStatus() {
    try {
        const response = await fetch(`${SERVER_URL}/api/status`);
        if (!response.ok) throw new Error('Server offline');

        const status = await response.json();
        displayServerStatus(status);
    } catch (e) {
        displayServerStatus({ phase: 'offline', message: 'Server not running' });
    }
}

function displayServerStatus(status) {
    const container = document.getElementById('serverStatus');
    if (!container) return;

    let html = '';

    if (status.phase === 'offline') {
        html = '<span style="color:#f66">⚫ Server offline</span>';
    } else if (!status.totalDownloads || status.totalDownloads === 0) {
        html = '<span style="color:#81c784">🟢 Server ready</span>';
    } else {
        // Filter out completed/error/cancelled
        const active = (status.downloads || []).filter(dl =>
            !['complete', 'error', 'cancelled'].includes(dl.phase)
        );

        if (active.length === 0) {
            html = '<span style="color:#81c784">🟢 Server ready</span>';
        } else {
            html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                <span style="color:#81c784">📥 ${active.length} active</span>
                <button data-action="cancel-all" style="font-size:9px;padding:2px 6px;background:#f66;border:none;color:#fff;border-radius:3px;cursor:pointer">Cancel All</button>
            </div>`;

            active.forEach(dl => {
                let icon = '⏳', color = '#888', info = dl.message || dl.phase, btns = '';

                if (dl.phase === 'downloading') {
                    icon = '⬇️'; color = '#54a0ff';
                    const pct = dl.total > 0 ? Math.round((dl.progress / dl.total) * 100) : 0;
                    info = `${pct}%`;
                    btns = `<button data-action="pause" data-id="${dl.id}" style="font-size:9px;padding:2px 5px;cursor:pointer;border:1px solid #666;background:#444;color:#fff;border-radius:3px;margin-left:4px">⏸</button>`;
                } else if (dl.phase === 'paused') {
                    icon = '⏸️'; color = '#feca57'; info = 'Paused';
                    btns = `<button data-action="resume" data-id="${dl.id}" style="font-size:9px;padding:2px 5px;cursor:pointer;border:1px solid #666;background:#444;color:#fff;border-radius:3px;margin-left:4px">▶</button>`;
                } else if (dl.phase === 'combining') {
                    icon = '🔧'; color = '#a29bfe';
                } else if (dl.phase === 'fetching') {
                    icon = '📋'; color = '#feca57';
                }
                btns += `<button data-action="cancel" data-id="${dl.id}" style="font-size:9px;padding:2px 5px;cursor:pointer;border:none;background:#f66;color:#fff;border-radius:3px;margin-left:3px">✕</button>`;

                // Format duration
                const durStr = dl.duration > 0 ? ` [${Math.floor(dl.duration / 60)}:${String(Math.floor(dl.duration % 60)).padStart(2, '0')}]` : '';
                const name = dl.filename.length > 12 ? dl.filename.substring(0, 12) + '..' : dl.filename;
                html += `<div style="font-size:10px;color:${color};padding:3px 0;display:flex;align-items:center;gap:4px"><span style="flex:1">${icon} ${name}${durStr}: ${info}</span>${btns}</div>`;
            });
        }
    }
    container.innerHTML = html;
}

// Event delegation for download controls (CSP-compliant)
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');

    try {
        if (action === 'pause') {
            await fetch(`${SERVER_URL}/api/pause/${id}`, { method: 'POST' });
        } else if (action === 'resume') {
            await fetch(`${SERVER_URL}/api/resume/${id}`, { method: 'POST' });
        } else if (action === 'cancel') {
            await fetch(`${SERVER_URL}/api/cancel/${id}`, { method: 'POST' });
        } else if (action === 'cancel-all') {
            await fetch(`${SERVER_URL}/api/cancel-all`, { method: 'POST' });
        }
    } catch (err) {
        console.error('Control action failed:', err);
    }
});

// ============ TAB SWITCHING ============
function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
    document.getElementById(`${tabName}-tab`).classList.add('active');

    addDebug(`Switched to ${tabName} tab`);
}

// ============ SETTINGS ============
function loadConfig() {
    chrome.runtime.sendMessage({ action: 'getConfig' }, (config) => {
        if (chrome.runtime.lastError || !config) return;

        // Only update fields if config has values (don't overwrite HTML defaults with empty)
        if (config.authorization) {
            document.getElementById('cfgAuth').value = config.authorization;
        }
        if (config.userId) {
            document.getElementById('cfgUserId').value = config.userId;
        }
        if (config.courseId) {
            document.getElementById('cfgCourseId').value = config.courseId;
        }
        if (config.apiBase) {
            document.getElementById('cfgApiBase').value = config.apiBase;
        }

        if (config.authorization) {
            document.getElementById('configStatus').textContent = '✅ Configuration loaded from storage';
        }
    });
}

function saveConfig() {
    const config = {
        authorization: document.getElementById('cfgAuth').value.trim(),
        userId: document.getElementById('cfgUserId').value.trim(),
        courseId: document.getElementById('cfgCourseId').value.trim() || '673',
        apiBase: document.getElementById('cfgApiBase').value.trim() || 'https://ignite247api.classx.co.in'
    };

    chrome.runtime.sendMessage({ action: 'saveConfig', config }, (response) => {
        if (response?.success) {
            document.getElementById('configStatus').innerHTML = '✅ <span style="color:#81c784;">Settings saved!</span>';
            addDebug('Config saved');
        } else {
            document.getElementById('configStatus').innerHTML = '❌ <span style="color:#f66;">Failed to save</span>';
        }
    });
}

function testConfig() {
    document.getElementById('configStatus').innerHTML = '⏳ Testing...';

    chrome.runtime.sendMessage({ action: 'testConfig' }, (response) => {
        if (response?.success) {
            document.getElementById('configStatus').innerHTML =
                `✅ <span style="color:#81c784;">Connected! Found ${response.count} items</span>`;
            addDebug(`Config test passed: ${response.count} items`);
        } else {
            document.getElementById('configStatus').innerHTML =
                `❌ <span style="color:#f66;">${response?.error || 'Connection failed'}</span>`;
            addDebug(`Config test failed: ${response?.error}`);
        }
    });
}

// ============ FOLDER PATH MANAGEMENT ============
function loadSavedFolderPath() {
    chrome.storage.local.get(['currentFolderPath'], (result) => {
        if (result.currentFolderPath) {
            currentFolderPath = result.currentFolderPath;
            updateFolderPathDisplay();
            addDebug(`Loaded saved folder path: ${currentFolderPath}`);
        }
    });
}

function setCurrentFolder(path) {
    currentFolderPath = path;
    chrome.storage.local.set({ currentFolderPath: path });
    updateFolderPathDisplay();
    addDebug(`Set folder path: ${path || 'root'}`);
}

function updateFolderPathDisplay() {
    const displayPath = currentFolderPath || 'None selected (root)';

    // Update Browse tab display
    const pathEl = document.getElementById('currentFolderPath');
    if (pathEl) {
        pathEl.textContent = displayPath;
    }

    // Update Streams tab display  
    const streamsPathEl = document.getElementById('streamsFolderPath');
    if (streamsPathEl) {
        streamsPathEl.textContent = displayPath;
    }
}

// Update video index display
function updateVideoNameDropdown() {
    updateIndexDisplay();
}

// Update the index display and populate the video name dropdown
function updateIndexDisplay() {
    const indexEl = document.getElementById('videoIndexDisplay');
    const dropdown = document.getElementById('videoNameDropdown');

    if (indexEl) {
        indexEl.textContent = videoIndex;
    }

    if (dropdown) {
        // Populate dropdown with all videos from current folder
        if (currentFolderVideos.length === 0) {
            dropdown.innerHTML = '<option value="">-- Select folder first --</option>';
        } else {
            dropdown.innerHTML = currentFolderVideos.map((video, i) => {
                const name = video.title.length > 40 ? video.title.substring(0, 40) + '...' : video.title;
                return `<option value="${i}" ${i === videoIndex ? 'selected' : ''}>${i}: ${name}</option>`;
            }).join('');

            if (videoIndex >= currentFolderVideos.length) {
                dropdown.innerHTML += `<option value="" selected disabled>⚠️ End of list (${currentFolderVideos.length} videos)</option>`;
            }
        }

        // Remove old listener and add new one
        dropdown.onchange = () => {
            const selected = parseInt(dropdown.value);
            if (!isNaN(selected)) {
                videoIndex = selected;
                if (indexEl) indexEl.textContent = videoIndex;
                addDebug(`Manually set index to ${videoIndex}: ${currentFolderVideos[videoIndex]?.title}`);
            }
        };
    }

    addDebug(`Index: ${videoIndex}/${currentFolderVideos.length}`);
}

// Reset video index to 0
function resetVideoIndex() {
    videoIndex = 0;
    updateIndexDisplay();
    addDebug('Video index reset to 0');
}

// ============ AUTO-SCRAPE ============
function startAutoScrape() {
    const startBtn = document.getElementById('startAutoScrapeBtn');
    const stopBtn = document.getElementById('stopAutoScrapeBtn');
    const statusEl = document.getElementById('autoScrapeStatus');

    startBtn.style.display = 'none';
    stopBtn.style.display = 'inline-block';
    statusEl.textContent = 'Starting auto-scrape...';
    statusEl.style.color = '#54a0ff';

    addDebug('Starting auto-scrape from index ' + videoIndex);

    // Extract video titles from loaded folder
    const videoTitles = currentFolderVideos.map(v => v.title);
    addDebug('Passing ' + videoTitles.length + ' video titles to filter');

    // Send message to content script to start automation
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
                action: 'startAutoScrape',
                startIndex: videoIndex,
                videoTitles: videoTitles,
                folderPath: currentFolderPath
            }, (response) => {
                if (chrome.runtime.lastError) {
                    statusEl.textContent = 'Error: ' + chrome.runtime.lastError.message;
                    statusEl.style.color = '#f66';
                    startBtn.style.display = 'inline-block';
                    stopBtn.style.display = 'none';
                }
            });
        }
    });
}

function stopAutoScrape() {
    const startBtn = document.getElementById('startAutoScrapeBtn');
    const stopBtn = document.getElementById('stopAutoScrapeBtn');
    const statusEl = document.getElementById('autoScrapeStatus');

    startBtn.style.display = 'inline-block';
    stopBtn.style.display = 'none';
    statusEl.textContent = 'Stopped';
    statusEl.style.color = '#888';

    addDebug('Stopping auto-scrape');

    // Send message to content script to stop automation
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'stopAutoScrape' });
        }
    });
}

// ============ FOLDER BROWSING ============
function loadRootFolders() {
    const btn = document.getElementById('loadRootBtn');
    btn.innerHTML = '<span class="loading-spinner">⏳</span> Loading...';
    btn.disabled = true;

    addDebug('Loading root folders...');

    chrome.runtime.sendMessage({ action: 'loadFolder', folderId: '-1' }, (response) => {
        btn.innerHTML = '📂 Load Folders';
        btn.disabled = false;

        if (response?.error) {
            document.getElementById('folderTree').innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">❌</div>
                    <p>Error: ${response.error}</p>
                    <small>Check Settings tab for configuration</small>
                </div>
            `;
            addDebug(`Error: ${response.error}`);
            return;
        }

        renderFolderTree(response.folders, response.videos, '-1');
        addDebug(`Loaded ${response.folders?.length || 0} folders, ${response.videos?.length || 0} videos`);
    });
}

function renderFolderTree(folders, videos, parentId) {
    const container = document.getElementById('folderTree');
    let html = '';

    // Render folders
    if (folders && folders.length > 0) {
        folders.forEach(folder => {
            html += `
                <div class="folder-item" data-id="${folder.id}" data-title="${escapeHtml(folder.title)}">
                    <span class="folder-arrow">▶</span>
                    <span>📁</span>
                    <span class="video-title">${escapeHtml(folder.title)}</span>
                </div>
                <div class="folder-children" id="folder-${folder.id}"></div>
            `;
        });
    }

    // Render videos (display only - no checkboxes since bulk download removed)
    if (videos && videos.length > 0) {
        videos.forEach(video => {
            html += `
                <div class="video-item" data-id="${video.id}" data-title="${escapeHtml(video.title)}" data-duration="${video.duration || ''}">
                    <span>🎬</span>
                    <span class="video-title">${escapeHtml(video.title)}</span>
                    <span class="video-duration">${video.duration || ''}</span>
                </div>
            `;
        });
    }

    if (!html) {
        html = `
            <div class="empty-state">
                <div class="empty-state-icon">📭</div>
                <p>No content found</p>
            </div>
        `;
    }

    container.innerHTML = html;
    attachEventHandlers(container);
}

function attachEventHandlers(container) {
    // Folder click handlers
    container.querySelectorAll('.folder-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.type === 'checkbox') return;
            toggleFolder(item.dataset.id, item.dataset.title);
        });
    });
}

function toggleFolder(folderId, folderTitle) {
    const childContainer = document.getElementById(`folder-${folderId}`);
    const folderItem = document.querySelector(`.folder-item[data-id="${folderId}"]`);
    const arrow = folderItem.querySelector('.folder-arrow');

    if (childContainer.classList.contains('expanded')) {
        childContainer.classList.remove('expanded');
        arrow.classList.remove('expanded');
        folderItem.classList.remove('expanded');
    } else {
        childContainer.classList.add('expanded');
        arrow.classList.add('expanded');
        folderItem.classList.add('expanded');

        if (!childContainer.innerHTML.trim()) {
            childContainer.innerHTML = '<div style="padding:8px;color:#888;font-size:10px;">Loading...</div>';

            // Get parent path from folderItem's parent or use root
            let parentPath = '';
            const parentContainer = folderItem.closest('.folder-children');
            if (parentContainer && parentContainer.id !== 'folderTree') {
                const parentFolderId = parentContainer.id.replace('folder-', '');
                parentPath = folderPaths.get(parentFolderId) || '';
            }

            // Build current folder path
            const sanitizedTitle = folderTitle.replace(/[<>:"/\\|?*]/g, '_').trim();
            const currentPath = parentPath ? `${parentPath}/${sanitizedTitle}` : sanitizedTitle;
            folderPaths.set(folderId, currentPath);

            // Set as current folder for downloads
            setCurrentFolder(currentPath);

            chrome.runtime.sendMessage({ action: 'loadFolder', folderId }, (response) => {
                if (response?.error) {
                    childContainer.innerHTML = `<div style="padding:8px;color:#f66;font-size:10px;">Error: ${response.error}</div>`;
                    return;
                }

                // Store videos for dropdown selector
                currentFolderVideos = response.videos || [];
                updateVideoNameDropdown();

                renderFolderContents(childContainer, response.folders, response.videos, folderId, currentPath);
                addDebug(`Loaded folder "${folderTitle}": ${response.videos?.length || 0} videos`);
            });
        }
    }
}

function renderFolderContents(container, folders, videos, parentId, folderPath = '') {
    let html = '';

    if (folders && folders.length > 0) {
        folders.forEach(folder => {
            html += `
                <div class="folder-item" data-id="${folder.id}" data-title="${escapeHtml(folder.title)}">
                    <span class="folder-arrow">▶</span>
                    <span>📁</span>
                    <span class="video-title">${escapeHtml(folder.title)}</span>
                </div>
                <div class="folder-children" id="folder-${folder.id}"></div>
            `;
        });
    }

    if (videos && videos.length > 0) {
        videos.forEach(video => {
            html += `
                <div class="video-item" data-id="${video.id}" data-title="${escapeHtml(video.title)}" data-duration="${video.duration || ''}" data-path="${escapeHtml(folderPath)}">
                    <span>🎬</span>
                    <span class="video-title">${escapeHtml(video.title)}</span>
                    <span class="video-duration">${video.duration || ''}</span>
                </div>
            `;
        });
    }

    if (!html) {
        html = '<div style="padding:8px;color:#888;font-size:10px;">Empty folder</div>';
    }

    container.innerHTML = html;
    attachEventHandlers(container);
}

// ============ STREAMS TAB ============
function loadStreams() {
    chrome.runtime.sendMessage({ action: 'getStreams' }, (response) => {
        if (chrome.runtime.lastError || !response) return;

        const streams = response.streams || [];

        document.getElementById('streamCount').textContent = streams.length;
        document.getElementById('segmentCount').textContent = streams.reduce((sum, s) => sum + (s.segmentCount || 0), 0);
        document.getElementById('durationCount').textContent = formatDuration(streams.reduce((sum, s) => sum + (s.duration || 0), 0));

        const listEl = document.getElementById('streamList');
        const downloadBtn = document.getElementById('downloadBtn');

        if (streams.length === 0) {
            listEl.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📺</div>
                    <p>No streams detected</p>
                    <small>Play a video to detect HLS streams</small>
                </div>
            `;
            downloadBtn.disabled = true;
            return;
        }

        listEl.innerHTML = streams.map(stream => `
            <div class="stream-item">
                <div class="stream-url" title="${stream.url}">${stream.url.substring(0, 60)}...</div>
            </div>
        `).join('');

        downloadBtn.disabled = false;
        downloadBtn.innerHTML = `<span>⬇️</span> Download (${streams.length} stream)`;
    });
}

function startStreamDownload() {
    const btn = document.getElementById('downloadBtn');
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span> Starting...';

    document.getElementById('progressContainer').style.display = 'block';

    // Show current folder in progress
    const folderInfo = currentFolderPath ? `📁 ${currentFolderPath}` : '📁 Root folder';
    addDebug(`Downloading to: ${folderInfo}`);

    chrome.runtime.sendMessage({ action: 'getStreams' }, (streamsResponse) => {
        if (!streamsResponse?.streams?.length) {
            btn.disabled = false;
            btn.innerHTML = '<span>❌</span> No streams';
            return;
        }

        const stream = streamsResponse.streams[0];

        // Get video name from auto-index or fallback
        let videoName = 'ignite_video';
        if (currentFolderVideos.length > 0 && videoIndex < currentFolderVideos.length) {
            videoName = currentFolderVideos[videoIndex].title.replace(/[<>:"/\\|?*]/g, '_');
        }

        // Build output name with folder path
        const outputName = currentFolderPath
            ? `${currentFolderPath}/${videoName}`
            : videoName;

        chrome.runtime.sendMessage({
            action: 'download',
            streamId: stream.id,
            outputName: outputName,
            folderPath: currentFolderPath
        }, (response) => {
            if (response?.success) {
                // Download queued - not complete yet!
                btn.innerHTML = '<span>📤</span> Queued';
                addDebug(`Download queued: ${outputName}`);

                // Increment video index for next download
                videoIndex++;
                updateIndexDisplay();

                // Clear the stream so user can detect new ones
                chrome.runtime.sendMessage({ action: 'clearStream', streamId: stream.id });

                // Reset button after short delay
                setTimeout(() => {
                    btn.disabled = false;
                    btn.innerHTML = '<span>⬇️</span> Download';
                    // Reload streams to show cleared state
                    loadStreams();
                }, 2000);
            } else {
                btn.innerHTML = `<span>❌</span> ${response?.message || 'Failed'}`;
                setTimeout(() => { btn.disabled = false; btn.innerHTML = '<span>⬇️</span> Download'; }, 3000);
            }

            document.getElementById('progressContainer').style.display = 'none';
        });
    });
}

function restoreDownloadState() {
    chrome.runtime.sendMessage({ action: 'getDownloadState' }, (state) => {
        if (!state || !state.isDownloading) return;
        document.getElementById('progressContainer').style.display = 'block';
        updateProgress(state.current, state.total, state.phase, state.bytes);
    });
}

function refreshPlaylist() {
    document.getElementById('refreshBtn').textContent = '⏳';
    chrome.runtime.sendMessage({ action: 'refresh' }, () => {
        setTimeout(() => {
            document.getElementById('refreshBtn').textContent = '🔄';
            loadStreams();
        }, 1000);
    });
}

function copyM3U8() {
    chrome.runtime.sendMessage({ action: 'getM3U8Url' }, (response) => {
        if (response?.url) {
            navigator.clipboard.writeText(response.url);
            document.getElementById('copyBtn').textContent = '✓';
            setTimeout(() => document.getElementById('copyBtn').textContent = '📋', 1500);
        }
    });
}

function clearAll() {
    chrome.runtime.sendMessage({ action: 'clear' }, () => {
        document.getElementById('successInfo').style.display = 'none';
        document.getElementById('progressContainer').style.display = 'none';
        loadStreams();
    });
}

// Listen for messages
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'downloadProgress') {
        updateProgress(message.current, message.total, message.phase, message.bytes);
    }
    if (message.action === 'streamsUpdated') {
        loadStreams();
    }
    if (message.action === 'debug') {
        addDebug(message.message);
    }
});

function updateProgress(current, total, phase = 'downloading', bytes = 0) {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    const sizeMB = bytes > 0 ? ` (${(bytes / 1024 / 1024).toFixed(1)} MB)` : '';

    document.getElementById('progressText').textContent = `${phase}: ${current}/${total}${sizeMB}`;
    document.getElementById('progressFill').style.width = `${percent}%`;
}

// ============ UTILITIES ============
function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '0s';
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
}

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
