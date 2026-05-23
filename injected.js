// Injected script - Runs in page context to intercept HLS.js and similar libraries
(function () {
    'use strict';

    // Intercept XMLHttpRequest for M3U8 detection
    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...args) {
        if (typeof url === 'string' && url.includes('.m3u8')) {
            window.postMessage({
                type: 'IGNITE_HLS_DETECTED',
                url: url,
                source: 'xhr'
            }, '*');
        }
        return originalXHROpen.call(this, method, url, ...args);
    };

    // Intercept fetch for M3U8 detection
    const originalFetch = window.fetch;
    window.fetch = function (url, ...args) {
        const urlString = typeof url === 'string' ? url : url?.url || url?.href;
        if (urlString && urlString.includes('.m3u8')) {
            window.postMessage({
                type: 'IGNITE_HLS_DETECTED',
                url: urlString,
                source: 'fetch'
            }, '*');
        }
        return originalFetch.call(this, url, ...args);
    };

    // Intercept HLS.js if present
    let hlsIntercepted = false;
    const interceptHls = () => {
        if (window.Hls && !hlsIntercepted) {
            hlsIntercepted = true;
            const originalHls = window.Hls;

            window.Hls = function (...args) {
                const instance = new originalHls(...args);
                const originalLoadSource = instance.loadSource.bind(instance);

                instance.loadSource = function (src) {
                    window.postMessage({
                        type: 'IGNITE_HLS_DETECTED',
                        url: src,
                        source: 'hls.js'
                    }, '*');
                    return originalLoadSource(src);
                };

                return instance;
            };

            // Copy static properties
            Object.assign(window.Hls, originalHls);
            window.Hls.prototype = originalHls.prototype;
        }
    };

    // Try to intercept HLS.js immediately and after a delay
    interceptHls();
    setTimeout(interceptHls, 1000);
    setTimeout(interceptHls, 3000);

    // Also intercept video.src setter
    const videoProto = HTMLVideoElement.prototype;
    const srcDescriptor = Object.getOwnPropertyDescriptor(videoProto, 'src') ||
        Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');

    if (srcDescriptor && srcDescriptor.set) {
        Object.defineProperty(videoProto, 'src', {
            get: srcDescriptor.get,
            set: function (value) {
                if (typeof value === 'string' && value.includes('.m3u8')) {
                    window.postMessage({
                        type: 'IGNITE_HLS_DETECTED',
                        url: value,
                        source: 'video-src-setter'
                    }, '*');
                }
                return srcDescriptor.set.call(this, value);
            },
            configurable: true,
            enumerable: true
        });
    }

    console.log('✅ IGNITE HLS interceptor injected');
})();
