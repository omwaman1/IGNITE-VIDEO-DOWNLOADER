// IGNITE HLS Downloader - Download Worker v3.4
// Simple OPFS + blob URL approach (no FFmpeg dependencies)

class OPFSWriter {
    constructor() {
        this.handles = new Map();
    }

    async open(filename) {
        const root = await navigator.storage.getDirectory();
        const fileHandle = await root.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        this.handles.set(filename, { handle: fileHandle, writable, size: 0 });
        console.log('[Worker] Opened file:', filename);
    }

    async write(filename, data) {
        const entry = this.handles.get(filename);
        if (!entry) throw new Error(`File not open: ${filename}`);
        await entry.writable.write(data);
        entry.size += data.byteLength;
    }

    async close(filename) {
        const entry = this.handles.get(filename);
        if (!entry) return 0;
        await entry.writable.close();
        const size = entry.size;
        this.handles.delete(filename);
        console.log('[Worker] Closed file:', filename, 'Size:', size);
        return size;
    }

    async getFile(filename) {
        const root = await navigator.storage.getDirectory();
        const fileHandle = await root.getFileHandle(filename);
        return await fileHandle.getFile();
    }

    async remove(filename) {
        try {
            const root = await navigator.storage.getDirectory();
            await root.removeEntry(filename);
            console.log('[Worker] Removed file:', filename);
        } catch (e) {
            console.log('[Worker] Remove failed:', e.message);
        }
    }
}

const opfs = new OPFSWriter();

// BroadcastChannel for communication with service worker
const channel = new BroadcastChannel('ignite_download_channel');

channel.onmessage = async (event) => {
    const { type, id, data } = event.data;
    console.log('[Worker] Received:', type, id);

    try {
        switch (type) {
            case 'open': {
                await opfs.open(data.filename);
                respond(id, { success: true });
                break;
            }

            case 'write': {
                await opfs.write(data.filename, new Uint8Array(data.chunk));
                respond(id, { success: true, bytesWritten: data.chunk.byteLength });
                break;
            }

            case 'close': {
                const size = await opfs.close(data.filename);
                respond(id, { success: true, totalSize: size });
                break;
            }

            case 'createBlobUrl': {
                // This is why we use a worker - URL.createObjectURL works here!
                const file = await opfs.getFile(data.filename);
                // Always use video/mp4 MIME type for better compatibility
                const mimeType = data.mimeType || 'video/mp4';
                const blob = new Blob([await file.arrayBuffer()], { type: mimeType });
                const blobUrl = URL.createObjectURL(blob);
                console.log('[Worker] Created blob URL:', blobUrl.substring(0, 50));
                respond(id, { success: true, blobUrl });
                break;
            }

            case 'revokeBlobUrl': {
                URL.revokeObjectURL(data.blobUrl);
                respond(id, { success: true });
                break;
            }

            case 'remove': {
                await opfs.remove(data.filename);
                respond(id, { success: true });
                break;
            }

            case 'ping': {
                respond(id, { success: true, ready: true });
                break;
            }
        }
    } catch (err) {
        console.error('[Worker] Error:', err);
        respond(id, { success: false, error: err.message });
    }
};

function respond(id, result) {
    console.log('[Worker] Responding:', id, result.success);
    channel.postMessage({ type: 'response', id, result });
}

console.log('[Download Worker] Ready - OPFS + BroadcastChannel');
