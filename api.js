const axios = require('axios');
const crypto = require('crypto');

const BASE_URL = 'https://ignite247api.classx.co.in';

const headers = {
    'authorization': 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjE0OTIwNiIsInRpbWVzdGFtcCI6MTc3NzM3NjczNSwiaXZfdmVyIjo3LCJzZXNzaW9uIjoiZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKSVV6STFOaUo5LmV5SnBaQ0k2SWpFME9USXdOaUlzSW1WdFlXbHNJam9pYzJGdWRHOXphR0YyWTJoaGNqUXhOREZBWjIxaGFXd3VZMjl0SWl3aWJtRnRaU0k2SWxOaGJuUnZjMmdnUW1oaFozZGhiaUJCZG1Ob1lYSWlMQ0owWlc1aGJuUlVlWEJsSWpvaWRYTmxjaUlzSW5SbGJtRnVkRTVoYldVaU9pSnBaMjVwZEdVeU5EZGZaR0lpTENKMFpXNWhiblJKWkNJNklpSXNJbVJwYzNCdmMyRmliR1VpT21aaGJITmxmUS41TkpnTFl2YXdHWmFVNVdoLUprYmZBSGVWbTQzMjJkemFoVEtxZVc4ejAwIn0.jjZKaukYPQsjAK1sauz8ZaCOuh9EsCFaSjWT4YxBz8g',
    'user-id': '149206',
    'auth-key': 'appxapi',
    'client-service': 'Appx',
    'source': 'windows',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ignite247/0.0.1 Chrome/108.0.5359.215 Electron/22.3.27 Safari/537.36'
};

// Decode JWT and check token age/validity
function getTokenInfo() {
    try {
        const token = headers.authorization;
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        const tokenTimestamp = payload.timestamp;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const ageSeconds = nowSeconds - tokenTimestamp;
        const ageDays = parseFloat((ageSeconds / 86400).toFixed(1));

        return {
            userId: payload.id,
            issuedAt: new Date(tokenTimestamp * 1000).toISOString(),
            ageDays,
            ageHours: parseFloat((ageSeconds / 3600).toFixed(1)),
            ivVersion: payload.iv_ver || null,
        };
    } catch (err) {
        return { error: err.message };
    }
}

// Make a lightweight API call to verify the token is actually accepted
async function checkAuth() {
    const tokenInfo = getTokenInfo();
    try {
        // Use a minimal API call to test auth
        const res = await axios.get(`${BASE_URL}/get/folder_contentsv3`, {
            headers,
            params: { course_id: 673, parent_id: -1, windowsapp: true, start: 0 },
            timeout: 10000
        });
        const status = res.status;
        const hasData = !!(res.data && (res.data.data || res.data.folders));
        return {
            ...tokenInfo,
            authenticated: status === 200 && hasData,
            httpStatus: status,
            message: hasData ? '✅ Token is valid and working' : '⚠️ Got 200 but no data — token may be partially expired'
        };
    } catch (err) {
        const status = err.response ? err.response.status : null;
        return {
            ...tokenInfo,
            authenticated: false,
            httpStatus: status,
            message: status === 401 || status === 403
                ? '❌ Token expired or invalid — please provide a fresh token'
                : `❌ API error: ${err.message}`
        };
    }
}

const AES_KEY = Buffer.from('638udh3829162018');

// ─── In-Memory Cache (1-hour TTL) ──────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const cache = new Map();

function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.time > CACHE_TTL_MS) {
        cache.delete(key);
        return null;
    }
    return entry.data;
}

function cacheSet(key, data) {
    cache.set(key, { data, time: Date.now() });
}

function clearCache() {
    const size = cache.size;
    cache.clear();
    console.log(`🗑️  Cache cleared (${size} entries removed)`);
    return size;
}

function getCacheStats() {
    let valid = 0, expired = 0;
    const now = Date.now();
    for (const [, entry] of cache) {
        if (now - entry.time > CACHE_TTL_MS) expired++;
        else valid++;
    }
    return { total: cache.size, valid, expired };
}

// ─── Throttled Request Queue ───────────────────────────────────────
// Serialises all outgoing API calls with a delay between each one,
// and retries automatically on HTTP 429 with exponential backoff.

const THROTTLE_MS = 500;          // min gap between requests
const MAX_RETRIES = 5;            // retry attempts on 429
const INITIAL_BACKOFF_MS = 5000;  // first retry wait (doubles each time)

let lastRequestTime = 0;
const requestQueue = [];
let queueRunning = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function enqueue(fn) {
    return new Promise((resolve, reject) => {
        requestQueue.push({ fn, resolve, reject });
        if (!queueRunning) drainQueue();
    });
}

async function drainQueue() {
    queueRunning = true;
    while (requestQueue.length > 0) {
        const { fn, resolve, reject } = requestQueue.shift();

        // Enforce minimum gap between requests
        const elapsed = Date.now() - lastRequestTime;
        if (elapsed < THROTTLE_MS) {
            await sleep(THROTTLE_MS - elapsed);
        }

        try {
            const result = await executeWithRetry(fn);
            lastRequestTime = Date.now();
            resolve(result);
        } catch (err) {
            lastRequestTime = Date.now();
            reject(err);
        }
    }
    queueRunning = false;
}

async function executeWithRetry(fn) {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (err) {
            const status = err.response ? err.response.status : null;
            if (status === 429 && attempt < MAX_RETRIES) {
                attempt++;
                const wait = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
                console.warn(`⏳ Rate limited (429) — retry ${attempt}/${MAX_RETRIES} in ${(wait / 1000).toFixed(0)}s...`);
                await sleep(wait);
                continue;
            }
            throw err;
        }
    }
}

// ─── Helpers ───────────────────────────────────────────────────────

function decryptUrl(encryptedString) {
    if (!encryptedString || !encryptedString.includes(':')) return null;
    try {
        const [enc, ivB64] = encryptedString.split(':');
        const iv = Buffer.from(ivB64, 'base64');
        const data = Buffer.from(enc, 'base64');
        const dec = crypto.createDecipheriv('aes-128-cbc', AES_KEY, iv);
        let decrypted = dec.update(data);
        decrypted = Buffer.concat([decrypted, dec.final()]);
        return decrypted.toString('utf8');
    } catch (err) {
        console.error('Decryption failed:', err.message);
        return null;
    }
}

// ─── API Functions (cache-first → throttle queue) ─────────────────

async function getFolderContents(courseId = 673, parentId = -1) {
    const cacheKey = `folder:${courseId}:${parentId}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
        console.log(`📦 Cache hit: ${cacheKey}`);
        return cached;
    }

    const data = await enqueue(async () => {
        const res = await axios.get(`${BASE_URL}/get/folder_contentsv3`, {
            headers,
            params: {
                course_id: courseId,
                parent_id: parentId,
                windowsapp: true,
                start: 0
            }
        });
        return res.data;
    });

    cacheSet(cacheKey, data);
    return data;
}

async function getVideoDetails(courseId, videoId) {
    const cacheKey = `video:${courseId}:${videoId}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
        console.log(`📦 Cache hit: ${cacheKey}`);
        return cached;
    }

    const data = await enqueue(async () => {
        const res = await axios.get(`${BASE_URL}/get/fetchVideoDetailsById`, {
            headers,
            params: {
                course_id: courseId,
                video_id: videoId,
                ytflag: 0,
                folder_wise_course: 1
            }
        });
        const vdata = res.data.data;

        // Decrypt all the URLs
        if (vdata.download_links) {
            vdata.download_links = vdata.download_links.map(l => ({
                ...l,
                url: decryptUrl(l.path)
            }));
        }
        if (vdata.file_link) {
            vdata.file_link_decrypted = decryptUrl(vdata.file_link);
        }
        if (vdata.pdf_link) {
            vdata.pdf_link_decrypted = decryptUrl(vdata.pdf_link);
        }

        return vdata;
    });

    cacheSet(cacheKey, data);
    return data;
}

module.exports = {
    getFolderContents,
    getVideoDetails,
    decryptUrl,
    checkAuth,
    getTokenInfo,
    clearCache,
    getCacheStats
};
