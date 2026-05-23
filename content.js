// Content script - Handles M3U8 parsing AND segment fetching
// KEY: Runs in page context with cookies!

(function () {
    'use strict';

    // Inject script for intercepting video sources
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.onload = function () { this.remove(); };
    (document.head || document.documentElement).appendChild(script);

    // Listen for messages from injected script
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data.type === 'IGNITE_HLS_DETECTED') {
            chrome.runtime.sendMessage({
                action: 'hlsDetected',
                url: event.data.url,
                source: event.data.source
            }).catch(() => { });
        }
    });

    // Handle requests from background script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'parseAndFetchM3U8') {
            parseAndDownloadHLS(request.m3u8Url, request.headers)
                .then(result => sendResponse(result))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;
        }

        if (request.action === 'fetchAllSegments') {
            fetchAllSegmentsFromPage(request.segments, request.headers)
                .then(result => sendResponse(result))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;
        }

        // Auto-scrape: Start automation
        if (request.action === 'startAutoScrape') {
            startAutoScrape(request.startIndex || 0, request.videoTitles || [], request.folderPath || '');
            sendResponse({ success: true, message: 'Auto-scrape started' });
            return true;
        }

        // Auto-scrape: Stop automation
        if (request.action === 'stopAutoScrape') {
            stopAutoScrape();
            sendResponse({ success: true, message: 'Auto-scrape stopped' });
            return true;
        }

        // Auto-scrape: Get status
        if (request.action === 'getAutoScrapeStatus') {
            sendResponse({
                running: autoScrapeState.running,
                currentIndex: autoScrapeState.currentIndex,
                totalVideos: autoScrapeState.totalVideos
            });
            return true;
        }

        // Auto-scrape: M3U8 captured notification
        if (request.action === 'notifyM3U8Captured') {
            if (autoScrapeState.running && autoScrapeState.waitingForCapture) {
                autoScrapeState.waitingForCapture = false;
                autoScrapeState.capturedUrl = request.url;
                console.log('[AUTO-SCRAPE] M3U8 captured, will proceed to next video');
            }
            sendResponse({ success: true });
            return true;
        }
    });

    // Parse M3U8 and download all segments - VDH style!
    async function parseAndDownloadHLS(m3u8Url, headers = {}) {
        console.log('[IGNITE] Parsing M3U8:', m3u8Url);
        sendProgress('Fetching M3U8 playlist...', 0, 1);

        // Step 1: Fetch M3U8 content
        let m3u8Content;
        try {
            const response = await fetch(m3u8Url, {
                credentials: 'include',
                headers: { 'Accept': '*/*', ...headers }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            m3u8Content = await response.text();
        } catch (err) {
            return { success: false, error: `Failed to fetch M3U8: ${err.message}` };
        }

        console.log('[IGNITE] M3U8 content length:', m3u8Content.length);

        // Step 2: Check if it's a master playlist (has variants)
        const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

        if (m3u8Content.includes('#EXT-X-STREAM-INF')) {
            // Master playlist - find best quality variant
            console.log('[IGNITE] Master playlist detected, finding best quality...');
            const variantUrl = findBestVariant(m3u8Content, baseUrl);
            if (!variantUrl) {
                return { success: false, error: 'No playable variant found in master playlist' };
            }
            console.log('[IGNITE] Using variant:', variantUrl);

            // Recursively fetch the variant playlist
            return parseAndDownloadHLS(variantUrl, headers);
        }

        // Step 3: Parse segments from media playlist
        const segments = parseMediaPlaylist(m3u8Content, baseUrl);
        if (!segments || segments.length === 0) {
            return { success: false, error: 'No segments found in playlist' };
        }

        console.log('[IGNITE] Found', segments.length, 'segments');
        sendProgress(`Found ${segments.length} segments, downloading...`, 0, segments.length);

        // Step 4: Download all segments
        const chunks = [];
        let totalBytes = 0;
        let successCount = 0;
        let failedCount = 0;
        let firstError = null;

        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];

            try {
                const response = await fetch(seg.url, {
                    credentials: 'include',
                    headers: { 'Accept': '*/*', ...headers }
                });

                if (!response.ok) {
                    failedCount++;
                    if (!firstError) firstError = `Segment ${i}: HTTP ${response.status}`;
                    continue;
                }

                const arrayBuffer = await response.arrayBuffer();

                // If there's an init segment, prepend it
                if (seg.init && i === 0) {
                    try {
                        const initResp = await fetch(seg.init, {
                            credentials: 'include',
                            headers: { 'Accept': '*/*', ...headers }
                        });
                        if (initResp.ok) {
                            const initData = await initResp.arrayBuffer();
                            chunks.push(new Uint8Array(initData));
                            totalBytes += initData.byteLength;
                        }
                    } catch (e) { console.warn('Init segment failed:', e); }
                }

                chunks.push(new Uint8Array(arrayBuffer));
                totalBytes += arrayBuffer.byteLength;
                successCount++;

                // Progress update
                if (i % 10 === 0 || i === segments.length - 1) {
                    sendProgress(`Downloading segments...`, i + 1, segments.length, totalBytes);
                }

            } catch (err) {
                failedCount++;
                if (!firstError) firstError = `Segment ${i}: ${err.message}`;
            }
        }

        if (successCount === 0) {
            return { success: false, error: `All segments failed! ${firstError}` };
        }

        // Step 5: Create blob and trigger download directly (bypass service worker!)
        sendProgress('Saving file...', segments.length, segments.length, totalBytes);

        // Detect file type from first chunk
        const firstBytes = chunks[0];
        const isFMP4 = firstBytes.length > 7 &&
            (firstBytes[4] === 0x66 && firstBytes[5] === 0x74 &&
                firstBytes[6] === 0x79 && firstBytes[7] === 0x70);

        const extension = isFMP4 ? 'mp4' : 'ts';
        const mimeType = isFMP4 ? 'video/mp4' : 'video/mp2t';
        const filename = `ignite_video.${extension}`;

        console.log('[IGNITE] Creating blob directly in content script...');
        const blob = new Blob(chunks, { type: mimeType });
        console.log('[IGNITE] Blob created:', (blob.size / 1024 / 1024).toFixed(1), 'MB');

        // Trigger download using anchor click (works in content script!)
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // Cleanup after a delay
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);

        console.log('[IGNITE] Download triggered:', filename);

        return {
            success: true,
            directDownload: true,
            filename: filename,
            totalBytes: totalBytes,
            successCount,
            failedCount,
            totalSegments: segments.length
        };
    }

    // Find best quality variant from master playlist
    function findBestVariant(content, baseUrl) {
        const lines = content.split('\n');
        let bestBandwidth = 0;
        let bestUrl = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('#EXT-X-STREAM-INF')) {
                const bwMatch = line.match(/BANDWIDTH=(\d+)/);
                const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;

                // Next line should be the URL
                const nextLine = lines[i + 1]?.trim();
                if (nextLine && !nextLine.startsWith('#')) {
                    if (bandwidth > bestBandwidth) {
                        bestBandwidth = bandwidth;
                        bestUrl = nextLine.startsWith('http') ? nextLine : baseUrl + nextLine;
                    }
                }
            }
        }

        return bestUrl;
    }

    // Parse media playlist to get segment URLs
    function parseMediaPlaylist(content, baseUrl) {
        const lines = content.split('\n');
        const segments = [];
        let currentInit = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Check for init segment (fMP4)
            if (line.startsWith('#EXT-X-MAP')) {
                const uriMatch = line.match(/URI="([^"]+)"/);
                if (uriMatch) {
                    currentInit = uriMatch[1].startsWith('http') ? uriMatch[1] : baseUrl + uriMatch[1];
                }
            }

            // Segment URL (non-comment, non-empty line after #EXTINF)
            if (line.startsWith('#EXTINF')) {
                const nextLine = lines[i + 1]?.trim();
                if (nextLine && !nextLine.startsWith('#') && nextLine.length > 0) {
                    const segUrl = nextLine.startsWith('http') ? nextLine : baseUrl + nextLine;
                    segments.push({
                        url: segUrl,
                        init: currentInit,
                        index: segments.length
                    });
                }
            }
        }

        return segments;
    }

    // Fetch segments directly (legacy support)
    async function fetchAllSegmentsFromPage(segments, headers = {}) {
        const chunks = [];
        let totalBytes = 0;
        let successCount = 0;
        let failedCount = 0;
        let firstError = null;

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            try {
                const response = await fetch(segment.url, {
                    credentials: 'include',
                    headers: { 'Accept': '*/*', ...headers }
                });

                if (!response.ok) {
                    failedCount++;
                    if (i === 0) firstError = `HTTP ${response.status}`;
                    continue;
                }

                const arrayBuffer = await response.arrayBuffer();
                chunks.push(new Uint8Array(arrayBuffer));
                totalBytes += arrayBuffer.byteLength;
                successCount++;

                if (i % 20 === 0 || i === segments.length - 1) {
                    sendProgress('Downloading...', i + 1, segments.length, totalBytes);
                }
            } catch (error) {
                failedCount++;
                if (i === 0) firstError = error.message;
            }
        }

        if (successCount === 0) {
            return { success: false, error: `All failed! ${firstError}` };
        }

        const combinedLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const combinedArray = new Uint8Array(combinedLength);
        let offset = 0;
        for (const chunk of chunks) {
            combinedArray.set(chunk, offset);
            offset += chunk.length;
        }

        const base64 = arrayBufferToBase64(combinedArray.buffer);
        return {
            success: true,
            data: base64,
            totalBytes: combinedLength,
            successCount,
            failedCount,
            totalSegments: segments.length
        };
    }

    function sendProgress(phase, current, total, bytes = 0) {
        chrome.runtime.sendMessage({
            action: 'downloadProgress',
            phase,
            current,
            total,
            bytes
        }).catch(() => { });
    }

    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        const len = bytes.length;
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < len; i += chunkSize) {
            const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
            binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
    }

    // Watch for video elements
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeName === 'VIDEO') checkVideoElement(node);
                if (node.querySelectorAll) {
                    node.querySelectorAll('video').forEach(checkVideoElement);
                }
            });
        });
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    function checkVideoElement(video) {
        if (video.src && video.src.includes('.m3u8')) {
            window.postMessage({ type: 'IGNITE_HLS_DETECTED', url: video.src, source: 'video-src' }, '*');
        }
        video.querySelectorAll('source').forEach((source) => {
            if (source.src && source.src.includes('.m3u8')) {
                window.postMessage({ type: 'IGNITE_HLS_DETECTED', url: source.src, source: 'source-element' }, '*');
            }
        });
    }

    document.querySelectorAll('video').forEach(checkVideoElement);
    console.log('[IGNITE HLS] Content script v2.9 loaded');

    // ============ AUTO-SCRAPE AUTOMATION ============
    const autoScrapeState = {
        running: false,
        currentIndex: 0,
        totalVideos: 0,
        waitingForCapture: false,
        capturedUrl: null,
        intervalId: null,
        videoTitles: [],
        matchedButtons: []
    };

    function startAutoScrape(startIndex = 0, videoTitles = [], folderPath = '') {
        console.log('[AUTO-SCRAPE] Starting from index:', startIndex, 'with', videoTitles.length, 'titles, folder:', folderPath);

        autoScrapeState.videoTitles = videoTitles;
        autoScrapeState.folderPath = folderPath;

        // Find watch buttons matching our video titles (or all if no titles)
        let matchedButtons = [];
        if (videoTitles.length > 0) {
            matchedButtons = findWatchButtonsForTitles(videoTitles);
        } else {
            matchedButtons = findWatchButtons().map((btn, i) => ({ button: btn, title: 'Video ' + i, index: i }));
        }

        if (matchedButtons.length === 0) {
            console.error('[AUTO-SCRAPE] No matching watch buttons found!');
            notifyPopup('error', 'No matching watch buttons found');
            return;
        }

        autoScrapeState.running = true;
        autoScrapeState.currentIndex = startIndex;
        autoScrapeState.totalVideos = matchedButtons.length;
        autoScrapeState.waitingForCapture = false;
        autoScrapeState.capturedUrl = null;
        autoScrapeState.matchedButtons = matchedButtons;

        console.log('[AUTO-SCRAPE] Found', matchedButtons.length, 'matching videos');
        notifyPopup('started', `Found ${matchedButtons.length} matching videos, starting from #${startIndex}`);

        // Start the automation loop
        processNextVideo();
    }

    function stopAutoScrape() {
        console.log('[AUTO-SCRAPE] Stopping...');
        autoScrapeState.running = false;
        autoScrapeState.waitingForCapture = false;
        if (autoScrapeState.intervalId) {
            clearInterval(autoScrapeState.intervalId);
            autoScrapeState.intervalId = null;
        }
        notifyPopup('stopped', 'Auto-scrape stopped');
    }

    function findWatchButtons() {
        // Find all "Watch" buttons on the page
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.filter(btn => {
            const text = btn.textContent?.trim().toLowerCase();
            return text === 'watch';
        });
    }

    function findWatchButtonsForTitles(videoTitles) {
        // Find watch buttons that are associated with our video titles
        // HTML structure: card div.rounded-2xl > ... > h4 (title) + button.Watch
        const matchedButtons = [];

        for (let i = 0; i < videoTitles.length; i++) {
            const title = videoTitles[i];
            const normalizedTitle = title.toLowerCase().trim();

            // Strategy 1: Find h4 elements containing the title
            const h4Elements = document.querySelectorAll('h4');
            let found = false;

            for (const h4 of h4Elements) {
                const h4Text = h4.textContent?.toLowerCase().trim() || '';

                // Check if h4 contains our title (partial match for numbered titles like "01. Pronoun")
                if (h4Text.includes(normalizedTitle) || normalizedTitle.includes(h4Text)) {
                    // Go up to find the card container (div with rounded-2xl or cursor-pointer)
                    const card = h4.closest('.rounded-2xl, .cursor-pointer, [class*="card"], [class*="item"]')
                        || h4.closest('div.flex')?.parentElement;

                    if (card) {
                        // Find Watch button in this card
                        const buttons = card.querySelectorAll('button');
                        for (const btn of buttons) {
                            if (btn.textContent?.trim().toLowerCase() === 'watch') {
                                // Check if button already matched (avoid duplicates)
                                const alreadyMatched = matchedButtons.some(m => m.button === btn);
                                if (!alreadyMatched) {
                                    matchedButtons.push({ button: btn, title: title, index: i });
                                    found = true;
                                    console.log('[AUTO-SCRAPE] Matched:', title, '-> h4:', h4Text);
                                }
                                break;
                            }
                        }
                    }
                    if (found) break;
                }
            }

            // Strategy 2: If not found via h4, try looking for any element with the title
            if (!found) {
                const allCards = document.querySelectorAll('.rounded-2xl, .cursor-pointer, [class*="video"]');
                for (const card of allCards) {
                    const cardText = card.textContent?.toLowerCase() || '';
                    if (cardText.includes(normalizedTitle)) {
                        const buttons = card.querySelectorAll('button');
                        for (const btn of buttons) {
                            if (btn.textContent?.trim().toLowerCase() === 'watch') {
                                // Check if button already matched (avoid duplicates)
                                const alreadyMatched = matchedButtons.some(m => m.button === btn);
                                if (!alreadyMatched) {
                                    matchedButtons.push({ button: btn, title: title, index: i });
                                    console.log('[AUTO-SCRAPE] Matched (fallback):', title);
                                    found = true;
                                }
                                break;
                            }
                        }
                    }
                    if (found) break;
                }
            }

            if (!found) {
                console.warn('[AUTO-SCRAPE] Could not match:', title);
            }
        }

        console.log('[AUTO-SCRAPE] Final matched buttons:', matchedButtons.length);
        matchedButtons.forEach((m, i) => console.log(`  [${i}] ${m.title}`));
        return matchedButtons;
    }

    async function processNextVideo() {
        if (!autoScrapeState.running) return;

        const matchedButtons = autoScrapeState.matchedButtons;

        if (autoScrapeState.currentIndex >= matchedButtons.length) {
            console.log('[AUTO-SCRAPE] All videos processed!');
            notifyPopup('complete', 'All videos processed!');
            stopAutoScrape();
            return;
        }

        const matched = matchedButtons[autoScrapeState.currentIndex];
        const button = matched.button;
        console.log('[AUTO-SCRAPE] Processing video', autoScrapeState.currentIndex + 1, 'of', matchedButtons.length, ':', matched.title);
        notifyPopup('progress', `${autoScrapeState.currentIndex + 1}/${matchedButtons.length}: ${matched.title.substring(0, 25)}...`);

        // Step 1: Click Watch button
        button.click();
        console.log('[AUTO-SCRAPE] Clicked Watch button for:', matched.title);

        // Step 2: Wait for quality modal and select 720p (with retry)
        let selected = false;
        for (let attempt = 0; attempt < 5 && !selected; attempt++) {
            await sleep(1000); // Wait 1s between attempts
            selected = await selectQuality('720p');
            if (!selected) {
                console.log('[AUTO-SCRAPE] Quality selection attempt', attempt + 1, 'failed, retrying...');
            }
        }
        if (!selected) {
            console.warn('[AUTO-SCRAPE] Could not select quality after 5 attempts, continuing...');
        }

        // Step 3: Wait for M3U8 capture
        autoScrapeState.waitingForCapture = true;
        autoScrapeState.capturedUrl = null;
        console.log('[AUTO-SCRAPE] Waiting for M3U8 capture...');

        // Wait up to 15 seconds for capture
        let waitTime = 0;
        while (autoScrapeState.waitingForCapture && waitTime < 15000 && autoScrapeState.running) {
            await sleep(500);
            waitTime += 500;
        }

        if (autoScrapeState.capturedUrl) {
            console.log('[AUTO-SCRAPE] M3U8 captured:', autoScrapeState.capturedUrl.substring(0, 50) + '...');

            // Step 3.5: Auto-trigger download with correct video name
            const videoName = matched.title.replace(/[<>:"/\\|?*]/g, '_');
            console.log('[AUTO-SCRAPE] Triggering download with name:', videoName);

            // Send message to background to trigger download
            chrome.runtime.sendMessage({
                action: 'autoDownload',
                videoName: videoName,
                folderPath: autoScrapeState.folderPath || ''
            }).catch(() => { });

            notifyPopup('downloading', `Downloading: ${matched.title.substring(0, 25)}...`);

            // Wait a bit for download to start
            await sleep(2000);
        } else {
            console.warn('[AUTO-SCRAPE] No M3U8 captured, skipping download...');
            notifyPopup('warning', `No URL captured for: ${matched.title.substring(0, 20)}...`);
        }

        // Step 4: Close the player with retry
        await sleep(1000);
        console.log('[AUTO-SCRAPE] Closing player...');

        let closed = false;
        for (let attempt = 0; attempt < 5 && !closed; attempt++) {
            closed = closePlayer();
            if (!closed) {
                console.log('[AUTO-SCRAPE] Close attempt', attempt + 1, 'failed, retrying...');
                await sleep(500);
            }
        }

        // Wait for modal to actually disappear
        let modalGone = false;
        for (let wait = 0; wait < 10 && !modalGone; wait++) {
            await sleep(300);
            const modal = document.querySelector('.modal-content, .modal.show, [class*="modal"][class*="show"]');
            modalGone = !modal;
        }

        if (!modalGone) {
            console.warn('[AUTO-SCRAPE] Modal still visible, trying ESC key...');
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }));
            await sleep(500);
        }

        // Step 5: Increment index and move to next video
        autoScrapeState.currentIndex++;
        console.log('[AUTO-SCRAPE] Moving to next video, index now:', autoScrapeState.currentIndex);

        // Wait longer for page to stabilize before next video
        console.log('[AUTO-SCRAPE] Waiting 3s for page to stabilize...');
        await sleep(3000);

        // Continue to next video
        if (autoScrapeState.running) {
            processNextVideo();
        }
    }

    async function selectQuality(quality) {
        // Wait for modal to appear
        await sleep(300);

        // Log what we can see
        const allBtns = document.querySelectorAll('button');
        console.log('[AUTO-SCRAPE] Total buttons on page:', allBtns.length);

        // Strategy 1: Find in modal-body (exact structure from user HTML)
        const modalBodyBtns = document.querySelectorAll('.modal-body button.btn-primary');
        console.log('[AUTO-SCRAPE] Found modal-body btn-primary:', modalBodyBtns.length);
        for (const btn of modalBodyBtns) {
            if (btn.textContent?.trim() === quality) {
                btn.click();
                console.log('[AUTO-SCRAPE] Selected quality:', quality);
                return true;
            }
        }

        // Strategy 2: Find by class and text
        const qualityButtons = document.querySelectorAll('.modal-body button, .modal-content button');
        for (const btn of qualityButtons) {
            if (btn.textContent?.includes(quality)) {
                btn.click();
                console.log('[AUTO-SCRAPE] Selected quality (modal):', quality);
                return true;
            }
        }

        // Strategy 3: Find any button with quality text
        for (const btn of allBtns) {
            if (btn.textContent?.trim() === quality) {
                btn.click();
                console.log('[AUTO-SCRAPE] Selected quality (any):', quality);
                return true;
            }
        }

        return false;
    }

    function closePlayer() {
        console.log('[AUTO-SCRAPE] Attempting to close player...');

        // Log what modals exist
        const modals = document.querySelectorAll('.modal-content');
        console.log('[AUTO-SCRAPE] Found .modal-content elements:', modals.length);

        // Strategy 1: Find the SVG with fa-circle-xmark class (exact from user HTML)
        const xmarkSvgs = document.querySelectorAll('svg.svg-inline--fa.fa-circle-xmark, svg.fa-circle-xmark');
        console.log('[AUTO-SCRAPE] Found fa-circle-xmark SVGs:', xmarkSvgs.length);
        for (const svg of xmarkSvgs) {
            const btn = svg.closest('button');
            if (btn) {
                btn.click();
                console.log('[AUTO-SCRAPE] Closed player (xmark svg)');
                return true;
            }
        }

        // Strategy 2: Find button in justify-self-end
        const justifyEndBtns = document.querySelectorAll('.justify-self-end button');
        console.log('[AUTO-SCRAPE] Found justify-self-end buttons:', justifyEndBtns.length);
        for (const btn of justifyEndBtns) {
            btn.click();
            console.log('[AUTO-SCRAPE] Closed player (justify-self-end)');
            return true;
        }

        // Strategy 3: Find btn-link in modal
        const linkBtns = document.querySelectorAll('.modal-content button.btn-link');
        console.log('[AUTO-SCRAPE] Found btn-link in modal:', linkBtns.length);
        for (const btn of linkBtns) {
            btn.click();
            console.log('[AUTO-SCRAPE] Closed player (btn-link)');
            return true;
        }

        // Strategy 4: Any button with SVG in modal
        const modalBtns = document.querySelectorAll('.modal-content button');
        for (const btn of modalBtns) {
            if (btn.querySelector('svg')) {
                btn.click();
                console.log('[AUTO-SCRAPE] Closed player (modal btn with svg)');
                return true;
            }
        }

        console.warn('[AUTO-SCRAPE] Could not find close button!');
        return false;
    }

    function notifyPopup(type, message) {
        chrome.runtime.sendMessage({
            action: 'autoScrapeStatus',
            type,
            message,
            currentIndex: autoScrapeState.currentIndex,
            totalVideos: autoScrapeState.totalVideos
        }).catch(() => { });
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
})();

