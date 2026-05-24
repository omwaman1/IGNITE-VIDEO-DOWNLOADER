const socket = io();

// UI Elements
const folderTree = document.getElementById('folder-tree');
const btnAddSelected = document.getElementById('btn-add-selected');
const queueList = document.getElementById('queue-list');
const emptyQueueState = document.getElementById('empty-queue-state');
const qualitySelect = document.getElementById('quality-select');
const concurrencyInput = document.getElementById('concurrency-input');
const basePathInput = document.getElementById('base-path-input');
const btnPauseAll = document.getElementById('btn-pause-all');
const btnResumeAll = document.getElementById('btn-resume-all');
const courseIdInput = document.getElementById('course-id-input');
const btnLoadCourse = document.getElementById('btn-load-course');
const modeSelect = document.getElementById('mode-select');

const statActive = document.getElementById('stat-active');
const statQueued = document.getElementById('stat-queued');
const statCompleted = document.getElementById('stat-completed');

// State
let selectedVideos = new Map(); // id -> title

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
    // Fetch initial course ID
    try {
        const res = await fetch('/api/config/course');
        const data = await res.json();
        if (data.courseId) courseIdInput.value = data.courseId;
    } catch (e) { console.error('Failed to init course ID'); }

    loadFolder('-1', folderTree, []); // Load root
});

// Event Listeners
btnAddSelected.addEventListener('click', addSelectedToQueue);

concurrencyInput.addEventListener('change', async (e) => {
    const max = parseInt(e.target.value);
    if (max >= 1) {
        await fetch('/api/queue/concurrency', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ max })
        });
    }
});

basePathInput.addEventListener('change', async (e) => {
    const newPath = e.target.value.trim();
    if (newPath) {
        try {
            const response = await fetch('/api/config/path', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: newPath })
            });
            const data = await response.json();
            if (data.path) {
                basePathInput.value = data.path;
                // Re-check downloaded status for all visible videos
                recheckAllVisibleVideos();
            } else {
                alert('Failed to update path (Invalid path). Try another absolute path.');
            }
        } catch (err) {
            console.error('Failed to change path', err);
        }
    }
});

btnLoadCourse.addEventListener('click', async () => {
    const courseId = courseIdInput.value.trim();
    if (!courseId) return;

    btnLoadCourse.disabled = true;
    btnLoadCourse.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        const res = await fetch('/api/config/course', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ courseId })
        });

        const data = await res.json();
        if (data.success) {
            // Uncheck everything
            selectedVideos.clear();
            updateAddButtonState();
            // Clear the tree
            folderTree.innerHTML = '<li class="loading-state"><i class="fa-solid fa-spinner fa-spin"></i> Loading Root...</li>';
            // Reload root
            await loadFolder('-1', folderTree, []);
        } else {
            alert('Failed to load course: ' + data.error);
        }
    } catch (e) {
        alert('Failed to connect to backend.');
    } finally {
        btnLoadCourse.disabled = false;
        btnLoadCourse.innerHTML = '<i class="fa-solid fa-rotate-right"></i> Load';
    }
});

btnPauseAll.addEventListener('click', async () => {
    await fetch('/api/queue/pause', { method: 'POST' });
});

btnResumeAll.addEventListener('click', async () => {
    await fetch('/api/queue/resume', { method: 'POST' });
});

// Socket Events — throttle UI updates to prevent DOM thrashing
let pendingState = null;
let rafId = null;

function throttledQueueUpdate(state) {
    pendingState = state;
    if (!rafId) {
        rafId = requestAnimationFrame(() => {
            rafId = null;
            if (pendingState) {
                updateQueueUI(pendingState);
                pendingState = null;
            }
        });
    }
}

socket.on('queue_init', updateQueueUI);
socket.on('queue_update', throttledQueueUpdate);


// --- Folder Tree Logic ---

async function loadFolder(parentId, parentUl, currentPath = []) {
    try {
        const response = await fetch(`/api/folders?parentId=${parentId}`);
        const data = await response.json();

        parentUl.innerHTML = ''; // clear loading state

        if (!data.data || data.data.length === 0) {
            parentUl.innerHTML = '<li style="padding: 5px 20px; color: var(--text-muted)">Empty folder</li>';
            return;
        }

        // Collect video items for bulk downloaded check
        const videoItems = [];

        data.data.forEach(item => {
            const li = document.createElement('li');
            li.className = 'tree-node';

            const isFolder = item.material_type === 'FOLDER';
            const icon = isFolder ? 'fa-folder' : 'fa-video';
            const itemClass = isFolder ? '' : 'video-item';

            // Build the folder path up to this item
            const itemFolderPath = [...currentPath];
            if (isFolder) {
                // We're a folder, so children should append our title
                itemFolderPath.push(item.Title);
            }

            const safeTitle = item.Title.replace(/"/g, '&quot;');
            const encodedPath = encodeURIComponent(JSON.stringify(currentPath));

            li.innerHTML = `
                <div class="tree-item ${itemClass}">
                    ${isFolder ? '<i class="fa-solid fa-chevron-right"></i>' : ''}
                    <input type="checkbox" class="checkbox-custom" data-id="${item.id}" data-title="${safeTitle}" data-type="${item.material_type}" data-folder-path="${encodedPath}" data-duration="${item.duration || ''}">
                    <i class="fa-solid ${icon} type-icon"></i>
                    <span class="tree-title">${item.Title}</span>
                    ${!isFolder && item.duration ? `<span class="badge duration-badge" style="font-size:0.75rem; color:var(--text-muted); margin-left:auto;">${item.duration}</span>` : ''}
                    ${isFolder ? `<span class="badge" style="font-size:0.75rem; color:var(--text-muted); margin-left:auto;">${item.videos_count} videos</span>` : ''}
                </div>
                ${isFolder ? '<ul class="tree-children"></ul>' : ''}
            `;

            const treeItem = li.querySelector('.tree-item');
            const checkbox = li.querySelector('input[type="checkbox"]');

            // Expand/Collapse Folder
            if (isFolder) {
                treeItem.addEventListener('click', (e) => {
                    if (e.target === checkbox) return;
                    li.classList.toggle('expanded');
                    const childrenUl = li.querySelector('.tree-children');
                    if (li.classList.contains('expanded') && childrenUl.children.length === 0) {
                        childrenUl.innerHTML = '<li class="loading-state" style="padding: 5px 20px"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</li>';
                        loadFolder(item.id, childrenUl, itemFolderPath);
                    }
                });
            }

            // Collect video info for bulk check
            if (!isFolder) {
                videoItems.push({ id: item.id, title: item.Title, folderPath: currentPath });
            }

            // Selection Logic
            checkbox.addEventListener('change', async (e) => {
                await handleSelection(e.target, li, isFolder, itemFolderPath);
            });

            parentUl.appendChild(li);
        });

        // Bulk check which videos are already downloaded
        if (videoItems.length > 0) {
            checkDownloadedStatus(videoItems, parentUl);
        }
    } catch (err) {
        parentUl.innerHTML = `<li style="color:var(--error); padding: 5px 20px;">Failed to load</li>`;
    }
}

async function checkDownloadedStatus(videoItems, containerUl) {
    try {
        const quality = qualitySelect.value;
        const mode = modeSelect.value;
        const res = await fetch('/api/check-downloaded', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videos: videoItems, quality, mode })
        });
        const data = await res.json();
        if (!data.results) return;

        for (const [videoId, isDownloaded] of Object.entries(data.results)) {
            if (!isDownloaded) continue;
            const checkbox = containerUl.querySelector(`input[data-id="${videoId}"]`);
            if (!checkbox) continue;

            const treeItem = checkbox.closest('.tree-item');
            if (treeItem) {
                treeItem.classList.add('already-downloaded');
                // Add downloaded badge if not already present
                if (!treeItem.querySelector('.downloaded-badge')) {
                    const badge = document.createElement('span');
                    badge.className = 'downloaded-badge';
                    badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Downloaded';
                    treeItem.appendChild(badge);
                }
            }
        }
    } catch (err) {
        console.error('Failed to check downloaded status', err);
    }
}

async function recheckAllVisibleVideos() {
    // Find all loaded folder containers that have video checkboxes
    const allVideoCheckboxes = folderTree.querySelectorAll('input[data-type="VIDEO"]');
    if (allVideoCheckboxes.length === 0) return;

    // Remove existing downloaded badges
    folderTree.querySelectorAll('.already-downloaded').forEach(el => {
        el.classList.remove('already-downloaded');
    });
    folderTree.querySelectorAll('.downloaded-badge').forEach(el => el.remove());

    // Group by parent UL for batch checking
    const groups = new Map();
    allVideoCheckboxes.forEach(cb => {
        const parentUl = cb.closest('ul');
        if (!groups.has(parentUl)) groups.set(parentUl, []);
        let folderPath = [];
        try { folderPath = JSON.parse(decodeURIComponent(cb.dataset.folderPath)); } catch (e) { }
        groups.get(parentUl).push({ id: cb.dataset.id, title: cb.dataset.title, folderPath });
    });

    for (const [parentUl, videos] of groups) {
        await checkDownloadedStatus(videos, parentUl);
    }
}

async function handleSelection(checkbox, li, isFolder, currentPath) {
    const isChecked = checkbox.checked;

    // Select/Deselect children if folder
    if (isFolder) {
        let childrenUl = li.querySelector('.tree-children');

        // If checking and not loaded yet, load it first
        if (isChecked && childrenUl && childrenUl.children.length === 0) {
            checkbox.disabled = true; // prevent interaction while loading
            childrenUl.innerHTML = '<li class="loading-state" style="padding: 5px 20px"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</li>';
            li.classList.add('expanded');

            const itemId = checkbox.dataset.id;
            await loadFolder(itemId, childrenUl, currentPath);
            checkbox.disabled = false;
        }

        // Now select all loaded children
        const childCheckboxes = li.querySelectorAll('.tree-children input[type="checkbox"]');
        childCheckboxes.forEach(cb => {
            // When checking a folder, skip already-downloaded videos
            if (isChecked && cb.dataset.type === 'VIDEO') {
                const treeItem = cb.closest('.tree-item');
                if (treeItem && treeItem.classList.contains('already-downloaded')) {
                    return; // Skip — already on disk
                }
            }
            if (cb.checked !== isChecked) {
                cb.checked = isChecked;
                // Dispatch change event to trigger recursive check for nested folders
                cb.dispatchEvent(new Event('change'));
            }
        });
    }

    updateSelectionState(checkbox);
    updateAddButtonState();
}

function updateSelectionState(checkbox) {
    if (checkbox.dataset.type === 'VIDEO') {
        if (checkbox.checked) {
            let folderPath = [];
            try { folderPath = JSON.parse(decodeURIComponent(checkbox.dataset.folderPath)); } catch (e) { }
            selectedVideos.set(checkbox.dataset.id, {
                title: checkbox.dataset.title,
                folderPath,
                duration: checkbox.dataset.duration || ''
            });
        } else {
            selectedVideos.delete(checkbox.dataset.id);
        }
    }
}

function updateAddButtonState() {
    const mode = modeSelect.value;
    const typeLabel = mode === 'pdf' ? 'PDF(s)' : 'Video(s)';

    // Count only videos that are NOT already downloaded
    let newCount = 0;
    let alreadyCount = 0;
    selectedVideos.forEach((data, id) => {
        const cb = document.querySelector(`input[data-id="${id}"]`);
        if (cb) {
            const treeItem = cb.closest('.tree-item');
            if (treeItem && treeItem.classList.contains('already-downloaded')) {
                alreadyCount++;
            } else {
                newCount++;
            }
        } else {
            newCount++;
        }
    });

    btnAddSelected.disabled = selectedVideos.size === 0;
    if (alreadyCount > 0) {
        btnAddSelected.innerHTML = `<i class="fa-solid fa-download"></i> Download ${newCount} New ${typeLabel} <span style="opacity:0.6;font-size:0.85em">(${alreadyCount} already done)</span>`;
    } else {
        btnAddSelected.innerHTML = `<i class="fa-solid fa-download"></i> Download ${newCount} ${typeLabel}`;
    }
}


// --- Queue Logic ---

async function addSelectedToQueue() {
    const quality = qualitySelect.value;
    const mode = modeSelect.value;
    const vids = Array.from(selectedVideos.entries());

    if (vids.length === 0) return;

    btnAddSelected.disabled = true;
    btnAddSelected.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Queuing ${vids.length}...`;

    try {
        const videosPayload = vids.map(([id, data]) => ({
            videoId: id,
            title: data.title,
            folderPath: data.folderPath,
            duration: data.duration || ''
        }));

        let result;
        if (mode === 'pdf') {
            const res = await fetch('/api/download-pdf-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videos: videosPayload })
            });
            result = await res.json();
        } else {
            const res = await fetch('/api/download-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videos: videosPayload, quality })
            });
            result = await res.json();
        }

        // Uncheck all in UI
        vids.forEach(([id]) => {
            const cb = document.querySelector(`input[data-id="${id}"]`);
            if (cb) cb.checked = false;
        });

        selectedVideos.clear();
        updateAddButtonState();

        // Show summary notification
        const typeLabel = mode === 'pdf' ? 'PDF(s)' : 'video(s)';
        const parts = [];
        if (result.queued > 0) parts.push(`Queued ${result.queued} ${typeLabel}`);
        if (result.skipped > 0) parts.push(`skipped ${result.skipped} already downloaded`);
        if (result.errors && result.errors.length > 0) parts.push(`${result.errors.length} failed`);
        if (parts.length > 0) showToast(parts.join(', ') + '.');

    } catch (e) {
        console.error('Batch download failed:', e);
        showToast('Failed to queue downloads. Check console.');
        btnAddSelected.disabled = false;
        updateAddButtonState();
        return;
    }

    // Refresh downloaded badges
    recheckAllVisibleVideos();
}

// Cache DOM element references per card to avoid querySelector on every update
const cardCache = new Map(); // taskId -> { elements, lastStatus, lastProgress }

function updateQueueUI(state) {
    if (document.activeElement !== basePathInput && state.baseDownloadPath) {
        basePathInput.value = state.baseDownloadPath;
    }

    if (state.paused) {
        btnPauseAll.style.display = 'none';
        btnResumeAll.style.display = 'flex';
    } else {
        btnPauseAll.style.display = 'flex';
        btnResumeAll.style.display = 'none';
    }

    statActive.innerText = state.activeCount;
    statQueued.innerText = state.queueLength;
    statCompleted.innerText = state.tasks.filter(t => t.status === 'completed').length;

    if (state.tasks.length === 0) {
        emptyQueueState.style.display = 'block';
        Array.from(queueList.children).forEach(c => {
            if (c.id !== 'empty-queue-state') c.remove();
        });
        cardCache.clear();
        return;
    }

    emptyQueueState.style.display = 'none';

    const sortedTasks = [...state.tasks].sort((a, b) => {
        const order = { 'downloading': 1, 'encoding': 2, 'queued': 3, 'error': 4, 'completed': 5 };
        return (order[a.status] || 6) - (order[b.status] || 6);
    });

    const activeIds = new Set(sortedTasks.map(t => `card-${t.id}`));
    Array.from(queueList.children).forEach(c => {
        if (c.id !== 'empty-queue-state' && !activeIds.has(c.id)) {
            c.remove();
            cardCache.delete(c.id.replace('card-', ''));
        }
    });

    sortedTasks.forEach(task => {
        let cached = cardCache.get(task.id);
        let card = cached ? cached.el : null;

        if (!card) {
            card = document.createElement('div');
            card.id = `card-${task.id}`;
            card.classList.add('card-new');
            card.innerHTML = `
                <div class="dl-header">
                    <div class="dl-title">
                        <i class="fa-brands fa-youtube" style="color:var(--error)"></i>
                        <span class="c-title"></span>
                        <span class="dl-quality c-quality"></span>
                        <span class="dl-duration c-duration-wrap" style="display:none"><i class="fa-regular fa-clock"></i> <span class="c-duration"></span></span>
                    </div>
                    <div class="dl-status c-status"></div>
                </div>
                <div class="progress-container c-prog-wrap">
                    <div class="progress-bar c-prog"></div>
                </div>
                <div class="dl-actions-wrap"></div>
                <div class="c-error" style="color:var(--error); font-size:0.8rem; margin-top:5px; display:none"></div>
            `;
            queueList.appendChild(card);
            setTimeout(() => card.classList.remove('card-new'), 350);

            // Cache element references once
            cached = {
                el: card,
                title: card.querySelector('.c-title'),
                quality: card.querySelector('.c-quality'),
                durationWrap: card.querySelector('.c-duration-wrap'),
                duration: card.querySelector('.c-duration'),
                status: card.querySelector('.c-status'),
                prog: card.querySelector('.c-prog'),
                progWrap: card.querySelector('.c-prog-wrap'),
                actionsWrap: card.querySelector('.dl-actions-wrap'),
                errorEl: card.querySelector('.c-error'),
                lastStatus: null,
                lastProgress: -1,
                lastError: null
            };
            cardCache.set(task.id, cached);

            // Set static fields once
            cached.title.textContent = task.title + ' ';
            cached.quality.textContent = task.quality;
            if (task.duration) {
                cached.durationWrap.style.display = 'inline';
                cached.duration.textContent = task.duration;
            }
        }

        // Skip update if nothing changed
        const progressRounded = Math.round(task.progress * 10) / 10;
        if (cached.lastStatus === task.status && cached.lastProgress === progressRounded && cached.lastError === (task.error || null)) {
            return;
        }

        // Update status class
        if (cached.lastStatus !== task.status) {
            card.classList.remove('status-queued', 'status-downloading', 'status-paused', 'status-completed', 'status-error', 'status-encoding');
            card.classList.add('download-card', `status-${task.status}`);

            // Rebuild action buttons only on status change
            let actionButtons = '';
            if (task.status === 'downloading') {
                actionButtons = `<button class="btn-action btn-pause" data-action="pause" data-task="${task.id}"><i class="fa-solid fa-pause"></i></button>`;
            } else if (task.status === 'paused') {
                actionButtons = `<button class="btn-action btn-resume" data-action="resume" data-task="${task.id}"><i class="fa-solid fa-play"></i></button>`;
            }
            if (['queued', 'downloading', 'paused', 'encoding'].includes(task.status)) {
                actionButtons += `<button class="btn-action btn-cancel" data-action="cancel" data-task="${task.id}" style="color:var(--error);"><i class="fa-solid fa-xmark"></i></button>`;
            }

            if (actionButtons) {
                cached.actionsWrap.innerHTML = `<div class="dl-actions">${actionButtons}</div>`;
                cached.progWrap.style.marginBottom = '10px';
            } else {
                cached.actionsWrap.innerHTML = '';
                cached.progWrap.style.marginBottom = '0';
            }
        }

        // Update progress text + bar
        let statusText = task.status;
        if (task.status === 'downloading') statusText = `Downloading (${progressRounded}%)`;
        if (task.status === 'encoding') statusText = `Fixing Seek (${progressRounded}%)`;
        if (task.status === 'error') statusText = 'Error';

        cached.status.textContent = statusText;
        cached.prog.style.width = `${task.progress}%`;

        // Error display
        if (task.error && cached.lastError !== task.error) {
            cached.errorEl.textContent = task.error;
            cached.errorEl.style.display = 'block';
        } else if (!task.error && cached.lastError) {
            cached.errorEl.style.display = 'none';
        }

        cached.lastStatus = task.status;
        cached.lastProgress = progressRounded;
        cached.lastError = task.error || null;
    });
}

// Event Delegation for individual task actions
queueList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-action');
    if (!btn) return;

    const action = btn.dataset.action;
    const taskId = btn.dataset.task;

    if (action && taskId) {
        // Optimistically disable button
        btn.disabled = true;
        try {
            await fetch(`/api/queue/task/${taskId}/${action}`, { method: 'POST' });
        } catch (err) {
            console.error(`Failed to ${action} task ${taskId}`, err);
            btn.disabled = false;
        }
    }
});

// Also re-check when quality changes, since different quality = different files
qualitySelect.addEventListener('change', () => {
    recheckAllVisibleVideos();
});

// Show/hide quality dropdown based on mode
modeSelect.addEventListener('change', () => {
    const isPdf = modeSelect.value === 'pdf';
    qualitySelect.closest('.control-group').style.display = isPdf ? 'none' : 'flex';
    updateAddButtonState();
    recheckAllVisibleVideos();
});

// Toast notification helper
function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}
