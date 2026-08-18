// ==UserScript==
// @name         磁力链接转种子下载
// @namespace    https://github.com/Kesuy/magnet-to-torrent-userscript
// @version      4.0.0
// @description  识别页面中的磁力链接，通过公共缓存或 qBittorrent 元数据解析下载 .torrent 文件
// @author       Kesuy
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      itorrents.net
// @connect      itorrents.org
// @connect      torrage.info
// @connect      btcache.me
// @connect      *
// @run-at       document-end
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/Kesuy/magnet-to-torrent-userscript/main/magnet-to-torrent.user.js
// @downloadURL  https://raw.githubusercontent.com/Kesuy/magnet-to-torrent-userscript/main/magnet-to-torrent.user.js
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = Object.freeze({
        torrentSources: Object.freeze([
            hash => `https://itorrents.net/torrent/${hash}.torrent`,
            hash => `https://torrage.info/torrent/${hash}.torrent`,
            hash => `https://itorrents.org/torrent/${hash}.torrent`,
            hash => `https://btcache.me/torrent/${hash}`,
        ]),
        cacheRequestTimeoutMs: 8000,
        buttonText: '📥 种子',
        debounceMs: 180,
        qbittorrent: Object.freeze({
            defaultUrl: 'http://127.0.0.1:8080',
            requestTimeoutMs: 10000,
            metadataTimeoutMs: 60000,
            pollIntervalMs: 2000,
            enabledStorageKey: 'mtt-qb-enabled',
            urlStorageKey: 'mtt-qb-url',
            apiKeyStorageKey: 'mtt-qb-api-key',
            metadataTimeoutStorageKey: 'mtt-qb-metadata-timeout-ms',
        }),
    });

    const OWNED_ATTR = 'data-mtt-owned';
    const PROCESSED_ATTR = 'data-mtt-processed';
    const STYLE_ID = 'mtt-styles';
    const QB_DIALOG_ID = 'mtt-qb-dialog';
    const CODE_SELECTOR = 'pre, code, div.blockcode';
    const SKIP_SELECTOR = `a, button, script, style, textarea, input, select, option, [contenteditable], [${OWNED_ATTR}]`;
    const BTIH_REGEX = /urn:btih:([a-f\d]{40}|[a-z2-7]{32})/i;
    const MAGNET_REGEX = /magnet:\?[^\s<>"'`]+/gi;
    const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    function decodeSafely(value) {
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }

    function normalizeHash(rawHash) {
        const hash = rawHash.trim().toUpperCase();
        if (/^[A-F\d]{40}$/.test(hash)) return hash;
        if (!/^[A-Z2-7]{32}$/.test(hash)) return null;

        let bits = '';
        for (const char of hash) {
            bits += BASE32.indexOf(char).toString(2).padStart(5, '0');
        }

        let hex = '';
        for (let index = 0; index < bits.length; index += 8) {
            hex += Number.parseInt(bits.slice(index, index + 8), 2)
                .toString(16)
                .padStart(2, '0');
        }
        return hex.toUpperCase();
    }

    function extractHash(value) {
        const match = decodeSafely(value).match(BTIH_REGEX);
        return match ? normalizeHash(match[1]) : null;
    }

    function torrentUrl(hash) {
        return CONFIG.torrentSources[0](hash);
    }

    function torrentUrls(hash) {
        return CONFIG.torrentSources.map(buildUrl => buildUrl(hash));
    }

    function getStoredValue(key, fallback) {
        if (typeof GM_getValue !== 'function') return fallback;
        return GM_getValue(key, fallback);
    }

    function setStoredValue(key, value) {
        if (typeof GM_setValue !== 'function') {
            throw new Error('当前 userscript 管理器不支持保存设置');
        }
        GM_setValue(key, value);
    }

    function normalizeQbUrl(value) {
        const raw = String(value || '').trim();
        if (!raw) throw new Error('请输入 qBittorrent WebUI 地址');

        let url;
        try {
            url = new URL(raw);
        } catch {
            throw new Error('qBittorrent WebUI 地址格式无效');
        }
        if (!['http:', 'https:'].includes(url.protocol)) {
            throw new Error('qBittorrent WebUI 地址仅支持 http 或 https');
        }
        if (url.username || url.password) {
            throw new Error('请不要把用户名或密码写入 WebUI 地址');
        }
        if (!url.hostname) throw new Error('qBittorrent WebUI 地址缺少主机名');
        url.search = '';
        url.hash = '';
        url.pathname = url.pathname.replace(/\/+$/, '');
        return url.toString().replace(/\/$/, '');
    }

    function getQbSettings() {
        const rawTimeout = Number(getStoredValue(
            CONFIG.qbittorrent.metadataTimeoutStorageKey,
            CONFIG.qbittorrent.metadataTimeoutMs,
        ));
        return {
            enabled: getStoredValue(CONFIG.qbittorrent.enabledStorageKey, false) === true,
            url: String(getStoredValue(CONFIG.qbittorrent.urlStorageKey, CONFIG.qbittorrent.defaultUrl)
                || CONFIG.qbittorrent.defaultUrl),
            apiKey: String(getStoredValue(CONFIG.qbittorrent.apiKeyStorageKey, '') || ''),
            metadataTimeoutMs: Number.isFinite(rawTimeout)
                ? Math.min(300000, Math.max(10000, Math.round(rawTimeout)))
                : CONFIG.qbittorrent.metadataTimeoutMs,
        };
    }

    function saveQbSettings(settings) {
        const timeout = Number(settings?.metadataTimeoutMs ?? CONFIG.qbittorrent.metadataTimeoutMs);
        if (!Number.isFinite(timeout) || timeout < 10000 || timeout > 300000) {
            throw new Error('元数据等待时间需在 10～300 秒之间');
        }
        const normalized = {
            enabled: Boolean(settings?.enabled),
            url: normalizeQbUrl(settings?.url),
            apiKey: String(settings?.apiKey || '').trim(),
            metadataTimeoutMs: Math.round(timeout),
        };
        setStoredValue(CONFIG.qbittorrent.enabledStorageKey, normalized.enabled);
        setStoredValue(CONFIG.qbittorrent.urlStorageKey, normalized.url);
        setStoredValue(CONFIG.qbittorrent.apiKeyStorageKey, normalized.apiKey);
        setStoredValue(CONFIG.qbittorrent.metadataTimeoutStorageKey, normalized.metadataTimeoutMs);
        return normalized;
    }

    function qbEndpoint(path, settings = getQbSettings()) {
        const base = normalizeQbUrl(settings.url);
        return `${base}${path.startsWith('/') ? path : `/${path}`}`;
    }

    function qbErrorMessage(response, path) {
        const body = String(response?.responseText || '').trim();
        if (response?.status === 401 || response?.status === 403) {
            return 'qBittorrent 拒绝访问；请配置 WebUI API Key，或确认该地址允许当前客户端免认证';
        }
        if (response?.status === 404 && path.includes('/torrents/')) {
            return 'qBittorrent 未提供元数据 API；请使用支持 WebAPI 2.11.9+ 的版本';
        }
        return `qBittorrent 请求失败（HTTP ${response?.status ?? '未知'}）${body ? `：${body}` : ''}`;
    }

    function requestQb(path, {
        method = 'GET',
        responseType = 'text',
        timeout = CONFIG.qbittorrent.requestTimeoutMs,
        allowedStatuses = [200],
        settings = getQbSettings(),
    } = {}) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('当前 userscript 管理器不支持 GM_xmlhttpRequest'));
                return;
            }

            let url;
            try {
                url = qbEndpoint(path, settings);
            } catch (error) {
                reject(error);
                return;
            }

            const headers = {};
            if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

            GM_xmlhttpRequest({
                method,
                url,
                headers,
                responseType,
                timeout,
                anonymous: true,
                onload(response) {
                    if (!allowedStatuses.includes(response.status)) {
                        const error = new Error(qbErrorMessage(response, path));
                        error.status = response.status;
                        reject(error);
                        return;
                    }
                    resolve(response);
                },
                onerror: () => reject(new Error('无法连接 qBittorrent，请检查 WebUI 地址、服务状态和 userscript 跨域权限')),
                ontimeout: () => reject(new Error('连接 qBittorrent 超时')),
            });
        });
    }

    async function testQbConnection(settings = getQbSettings()) {
        const response = await requestQb('/api/v2/app/version', { settings, responseType: 'text' });
        const version = String(response.responseText || response.response || '').trim();
        if (!version) throw new Error('qBittorrent 已响应，但未返回版本号');
        return { version };
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function trimMagnet(raw) {
        return raw.replace(/[.,;:!?)}\]]+$/g, '');
    }

    function findMagnets(text) {
        const results = [];
        for (const match of text.matchAll(MAGNET_REGEX)) {
            const magnet = trimMagnet(match[0]);
            const hash = extractHash(magnet);
            if (!hash) continue;
            results.push({ magnet, hash, index: match.index });
        }
        return results;
    }

    function parseBencode(input) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        const decoder = new TextDecoder();
        let offset = 0;

        function parseBytes() {
            const lengthStart = offset;
            while (offset < bytes.length && bytes[offset] >= 48 && bytes[offset] <= 57) offset += 1;
            if (offset === lengthStart || bytes[offset] !== 58) throw new Error('无效的 bencode 字符串');
            const length = Number.parseInt(decoder.decode(bytes.subarray(lengthStart, offset)), 10);
            offset += 1;
            const end = offset + length;
            if (!Number.isSafeInteger(length) || length < 0 || end > bytes.length) {
                throw new Error('bencode 字符串长度越界');
            }
            const value = bytes.subarray(offset, end);
            offset = end;
            return value;
        }

        function parseValue(depth = 0) {
            if (depth > 100 || offset >= bytes.length) throw new Error('无效的 bencode 数据');
            const token = bytes[offset];

            if (token >= 48 && token <= 57) return parseBytes();
            if (token === 105) {
                offset += 1;
                const start = offset;
                while (offset < bytes.length && bytes[offset] !== 101) offset += 1;
                if (offset >= bytes.length) throw new Error('未结束的 bencode 整数');
                const value = Number.parseInt(decoder.decode(bytes.subarray(start, offset)), 10);
                offset += 1;
                if (!Number.isSafeInteger(value)) throw new Error('无效的 bencode 整数');
                return value;
            }
            if (token === 108) {
                offset += 1;
                const list = [];
                while (offset < bytes.length && bytes[offset] !== 101) list.push(parseValue(depth + 1));
                if (offset >= bytes.length) throw new Error('未结束的 bencode 列表');
                offset += 1;
                return list;
            }
            if (token === 100) {
                offset += 1;
                const dictionary = Object.create(null);
                while (offset < bytes.length && bytes[offset] !== 101) {
                    const key = decoder.decode(parseBytes());
                    dictionary[key] = parseValue(depth + 1);
                }
                if (offset >= bytes.length) throw new Error('未结束的 bencode 字典');
                offset += 1;
                return dictionary;
            }
            throw new Error('未知的 bencode 类型');
        }

        const result = parseValue();
        if (offset !== bytes.length) throw new Error('bencode 数据尾部存在多余内容');
        return result;
    }

    function parseTorrentName(input) {
        const root = parseBencode(input);
        const info = root?.info;
        const rawName = info?.['name.utf-8'] || info?.name;
        if (!(rawName instanceof Uint8Array)) throw new Error('torrent 中缺少 info.name');
        const name = new TextDecoder('utf-8').decode(rawName).replace(/\0/g, '').trim();
        if (!name) throw new Error('torrent 名称为空');
        return name;
    }

    function extractInfoBytes(input) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        const decoder = new TextDecoder();
        let offset = 0;

        function skipBytes() {
            const start = offset;
            while (offset < bytes.length && bytes[offset] >= 48 && bytes[offset] <= 57) offset += 1;
            if (offset === start || bytes[offset] !== 58) throw new Error('无效的 bencode 字符串');
            const length = Number.parseInt(decoder.decode(bytes.subarray(start, offset)), 10);
            offset += 1 + length;
            if (!Number.isSafeInteger(length) || length < 0 || offset > bytes.length) {
                throw new Error('bencode 字符串长度越界');
            }
        }

        function skipValue(depth = 0) {
            if (depth > 100 || offset >= bytes.length) throw new Error('无效的 bencode 数据');
            const token = bytes[offset];
            if (token >= 48 && token <= 57) {
                skipBytes();
            } else if (token === 105) {
                offset = bytes.indexOf(101, offset + 1);
                if (offset < 0) throw new Error('未结束的 bencode 整数');
                offset += 1;
            } else if (token === 108 || token === 100) {
                offset += 1;
                while (offset < bytes.length && bytes[offset] !== 101) {
                    if (token === 100) skipBytes();
                    skipValue(depth + 1);
                }
                if (offset >= bytes.length) throw new Error('未结束的 bencode 容器');
                offset += 1;
            } else {
                throw new Error('未知的 bencode 类型');
            }
        }

        if (bytes[offset] !== 100) throw new Error('torrent 根节点不是字典');
        offset += 1;
        while (offset < bytes.length && bytes[offset] !== 101) {
            const keyStart = offset;
            skipBytes();
            const colon = bytes.indexOf(58, keyStart);
            const key = decoder.decode(bytes.subarray(colon + 1, offset));
            const valueStart = offset;
            skipValue(1);
            if (key === 'info') return bytes.subarray(valueStart, offset);
        }
        throw new Error('torrent 中缺少 info 字典');
    }

    function sha1Hex(input) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
        const padded = new Uint8Array(paddedLength);
        padded.set(bytes);
        padded[bytes.length] = 0x80;
        const view = new DataView(padded.buffer);
        const bitLength = bytes.length * 8;
        view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
        view.setUint32(paddedLength - 4, bitLength >>> 0);

        let h0 = 0x67452301;
        let h1 = 0xEFCDAB89;
        let h2 = 0x98BADCFE;
        let h3 = 0x10325476;
        let h4 = 0xC3D2E1F0;
        const words = new Uint32Array(80);
        const rotateLeft = (value, bits) => (value << bits) | (value >>> (32 - bits));

        for (let chunk = 0; chunk < paddedLength; chunk += 64) {
            for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(chunk + index * 4);
            for (let index = 16; index < 80; index += 1) {
                words[index] = rotateLeft(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1) >>> 0;
            }
            let a = h0;
            let b = h1;
            let c = h2;
            let d = h3;
            let e = h4;
            for (let index = 0; index < 80; index += 1) {
                let f;
                let k;
                if (index < 20) {
                    f = (b & c) | (~b & d);
                    k = 0x5A827999;
                } else if (index < 40) {
                    f = b ^ c ^ d;
                    k = 0x6ED9EBA1;
                } else if (index < 60) {
                    f = (b & c) | (b & d) | (c & d);
                    k = 0x8F1BBCDC;
                } else {
                    f = b ^ c ^ d;
                    k = 0xCA62C1D6;
                }
                const temp = (rotateLeft(a, 5) + f + e + k + words[index]) >>> 0;
                e = d;
                d = c;
                c = rotateLeft(b, 30) >>> 0;
                b = a;
                a = temp;
            }
            h0 = (h0 + a) >>> 0;
            h1 = (h1 + b) >>> 0;
            h2 = (h2 + c) >>> 0;
            h3 = (h3 + d) >>> 0;
            h4 = (h4 + e) >>> 0;
        }
        return [h0, h1, h2, h3, h4].map(value => value.toString(16).padStart(8, '0')).join('').toUpperCase();
    }

    async function verifyTorrentHash(input, expectedHash) {
        const actualHash = sha1Hex(extractInfoBytes(input));
        if (actualHash !== expectedHash.toUpperCase()) {
            throw new Error(`torrent infohash 不匹配（期望 ${expectedHash}，实际 ${actualHash}）`);
        }
        return true;
    }

    function sanitizeFilename(name) {
        const replacements = {
            '<': '＜', '>': '＞', ':': '：', '"': '＂', '/': '／', '\\': '＼',
            '|': '｜', '?': '？', '*': '＊',
        };
        let safe = name.normalize('NFKC')
            .replace(/[<>:"/\\|?*]/g, char => replacements[char])
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .replace(/[. ]+$/g, '')
            .trim();
        safe = [...safe].slice(0, 180).join('').replace(/[. ]+$/g, '');
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
        return safe;
    }

    function torrentFilename(input, fallbackHash) {
        let name;
        try {
            name = sanitizeFilename(parseTorrentName(input));
        } catch {
            name = fallbackHash;
        }
        if (!name) name = 'download';
        return /\.torrent$/i.test(name) ? name : `${name}.torrent`;
    }

    function requestTorrentUrl(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('当前 userscript 管理器不支持 GM_xmlhttpRequest'));
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'arraybuffer',
                timeout: CONFIG.cacheRequestTimeoutMs,
                anonymous: true,
                onload(response) {
                    if (response.status < 200 || response.status >= 300 || !response.response) {
                        reject(new Error(`下载 torrent 失败（HTTP ${response.status}）`));
                        return;
                    }
                    resolve(new Uint8Array(response.response));
                },
                onerror: () => reject(new Error('下载 torrent 时发生网络错误')),
                ontimeout: () => reject(new Error('下载 torrent 超时')),
            });
        });
    }

    async function requestTorrentFromCaches(hash) {
        const errors = [];
        for (const url of torrentUrls(hash)) {
            try {
                const bytes = await requestTorrentUrl(url);
                parseTorrentName(bytes);
                await verifyTorrentHash(bytes, hash);
                return bytes;
            } catch (error) {
                errors.push(`${new URL(url).hostname}: ${error?.message || error}`);
            }
        }
        const error = new Error(`所有 torrent 缓存源均不可用：${errors.join('；')}`);
        error.cacheErrors = errors;
        throw error;
    }

    async function requestTorrentViaQbittorrent(hash, magnet = '', settings = getQbSettings()) {
        if (!settings.enabled) throw new Error('qBittorrent 回退未启用');

        const source = magnet && extractHash(magnet) === hash.toUpperCase()
            ? magnet
            : `magnet:?xt=urn:btih:${hash}`;
        const query = `source=${encodeURIComponent(source)}`;
        const deadline = Date.now() + settings.metadataTimeoutMs;
        const fetchPath = `/api/v2/torrents/fetchMetadata?${query}`;
        const savePath = `/api/v2/torrents/saveMetadata?${query}`;

        while (Date.now() < deadline) {
            const remaining = Math.max(1000, deadline - Date.now());
            const response = await requestQb(fetchPath, {
                settings,
                responseType: 'text',
                timeout: Math.min(CONFIG.qbittorrent.requestTimeoutMs, remaining),
                allowedStatuses: [200, 202],
            });
            if (response.status === 200) {
                const saved = await requestQb(savePath, {
                    settings,
                    responseType: 'arraybuffer',
                    timeout: Math.min(CONFIG.qbittorrent.requestTimeoutMs, remaining),
                    allowedStatuses: [200, 409],
                });
                if (saved.status === 200 && saved.response) {
                    const bytes = new Uint8Array(saved.response);
                    parseTorrentName(bytes);
                    await verifyTorrentHash(bytes, hash);
                    return bytes;
                }
            }
            const delay = Math.min(CONFIG.qbittorrent.pollIntervalMs, Math.max(0, deadline - Date.now()));
            if (delay > 0) await sleep(delay);
        }

        throw new Error(`qBittorrent 在 ${Math.round(settings.metadataTimeoutMs / 1000)} 秒内未获取到元数据（可能没有可用的 DHT/Peer）`);
    }

    async function requestTorrent(hash, magnet = '', onStage = () => {}) {
        let cacheError;
        onStage('cache');
        try {
            return await requestTorrentFromCaches(hash);
        } catch (error) {
            cacheError = error;
        }

        const settings = getQbSettings();
        if (!settings.enabled) throw cacheError;

        onStage('qbittorrent');
        try {
            return await requestTorrentViaQbittorrent(hash, magnet, settings);
        } catch (qbError) {
            throw new Error(`${cacheError.message}；qBittorrent：${qbError?.message || qbError}`);
        }
    }

    async function downloadTorrent(hash, magnet = '', onStage = () => {}) {
        const bytes = await requestTorrent(hash, magnet, onStage);
        const filename = torrentFilename(bytes, hash);
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/x-bittorrent' }));
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = filename;
        anchor.style.display = 'none';
        anchor.setAttribute(OWNED_ATTR, '');
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        return filename;
    }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.setAttribute(OWNED_ATTR, '');
        style.textContent = `
            .mtt-button { display:inline-block; margin-left:6px; padding:2px 8px; border-radius:3px;
                background:#28a745 !important; color:#fff !important; font:12px/1.5 sans-serif;
                text-decoration:none !important; cursor:pointer; vertical-align:middle; }
            .mtt-button:hover, .mtt-button:focus-visible { background:#218838 !important; }
            .mtt-magnet { overflow-wrap:anywhere; }
            .mtt-code-buttons { display:block; margin-top:4px; }
            .mtt-qb-overlay { position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center;
                justify-content:center; padding:20px; background:rgba(0,0,0,.5); font:14px/1.5 sans-serif; }
            .mtt-qb-panel { width:min(560px, 100%); box-sizing:border-box; padding:20px; border-radius:10px;
                background:#fff; color:#222; box-shadow:0 12px 40px rgba(0,0,0,.3); }
            .mtt-qb-panel h2 { margin:0 0 8px; font-size:20px; }
            .mtt-qb-panel p { margin:0 0 14px; color:#555; }
            .mtt-qb-field { display:block; margin:12px 0; font-weight:600; }
            .mtt-qb-field input[type="url"], .mtt-qb-field input[type="password"], .mtt-qb-field input[type="number"] {
                display:block; width:100%; box-sizing:border-box; margin-top:5px; padding:8px 10px;
                border:1px solid #bbb; border-radius:5px; background:#fff; color:#222; font:14px/1.4 monospace; }
            .mtt-qb-check { display:flex; gap:8px; align-items:center; margin:12px 0; font-weight:600; }
            .mtt-qb-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:16px; }
            .mtt-qb-actions button { padding:7px 14px; border:1px solid #aaa; border-radius:5px; cursor:pointer; }
            .mtt-qb-actions button[type="submit"] { border-color:#1677ff; background:#1677ff; color:#fff; }
            .mtt-qb-status { min-height:21px; margin-top:12px; color:#555; overflow-wrap:anywhere; }
            .mtt-qb-status[data-kind="success"] { color:#16803c; }
            .mtt-qb-status[data-kind="error"] { color:#c5221f; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function openQbSettings() {
        if (!document.body) throw new Error('页面尚未加载完成');
        document.getElementById(QB_DIALOG_ID)?.remove();
        injectStyles();

        const current = getQbSettings();
        const overlay = document.createElement('div');
        overlay.id = QB_DIALOG_ID;
        overlay.className = 'mtt-qb-overlay';
        overlay.setAttribute(OWNED_ATTR, '');

        const panel = document.createElement('form');
        panel.className = 'mtt-qb-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'mtt-qb-title');

        const title = document.createElement('h2');
        title.id = 'mtt-qb-title';
        title.textContent = 'qBittorrent 元数据回退设置';
        const description = document.createElement('p');
        description.textContent = '公共缓存均失败后，脚本可调用 qBittorrent WebAPI 从 DHT/Peer 获取元数据。推荐配置 WebUI API Key；此流程不会把任务添加到下载列表。';

        const enabledLabel = document.createElement('label');
        enabledLabel.className = 'mtt-qb-check';
        const enabledInput = document.createElement('input');
        enabledInput.name = 'qb-enabled';
        enabledInput.type = 'checkbox';
        enabledInput.checked = current.enabled;
        enabledLabel.append(enabledInput, document.createTextNode('启用 qBittorrent 回退'));

        const urlLabel = document.createElement('label');
        urlLabel.className = 'mtt-qb-field';
        urlLabel.textContent = 'WebUI 地址';
        const urlInput = document.createElement('input');
        urlInput.name = 'qb-url';
        urlInput.type = 'url';
        urlInput.required = true;
        urlInput.value = current.url;
        urlInput.placeholder = CONFIG.qbittorrent.defaultUrl;
        urlInput.autocomplete = 'url';
        urlLabel.appendChild(urlInput);

        const apiKeyLabel = document.createElement('label');
        apiKeyLabel.className = 'mtt-qb-field';
        apiKeyLabel.textContent = 'WebUI API Key（推荐）';
        const apiKeyInput = document.createElement('input');
        apiKeyInput.name = 'qb-api-key';
        apiKeyInput.type = 'password';
        apiKeyInput.value = current.apiKey;
        apiKeyInput.placeholder = 'Bearer API Key；本机免认证时可留空';
        apiKeyInput.autocomplete = 'off';
        apiKeyLabel.appendChild(apiKeyInput);

        const timeoutLabel = document.createElement('label');
        timeoutLabel.className = 'mtt-qb-field';
        timeoutLabel.textContent = '等待元数据（秒）';
        const timeoutInput = document.createElement('input');
        timeoutInput.name = 'qb-timeout';
        timeoutInput.type = 'number';
        timeoutInput.min = '10';
        timeoutInput.max = '300';
        timeoutInput.step = '1';
        timeoutInput.required = true;
        timeoutInput.value = String(Math.round(current.metadataTimeoutMs / 1000));
        timeoutLabel.appendChild(timeoutInput);

        const status = document.createElement('div');
        status.className = 'mtt-qb-status';
        status.setAttribute('aria-live', 'polite');
        const setStatus = (message, kind = '') => {
            status.textContent = message;
            status.dataset.kind = kind;
        };
        const formSettings = () => ({
            enabled: enabledInput.checked,
            url: urlInput.value,
            apiKey: apiKeyInput.value,
            metadataTimeoutMs: Number(timeoutInput.value) * 1000,
        });

        const actions = document.createElement('div');
        actions.className = 'mtt-qb-actions';
        const saveButton = document.createElement('button');
        saveButton.type = 'submit';
        saveButton.textContent = '保存';
        const testButton = document.createElement('button');
        testButton.type = 'button';
        testButton.textContent = '测试连接';
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.textContent = '关闭';
        actions.append(saveButton, testButton, closeButton);

        const close = () => overlay.remove();
        closeButton.addEventListener('click', close);
        overlay.addEventListener('click', event => {
            if (event.target === overlay) close();
        });
        panel.addEventListener('submit', event => {
            event.preventDefault();
            try {
                const saved = saveQbSettings(formSettings());
                enabledInput.checked = saved.enabled;
                urlInput.value = saved.url;
                apiKeyInput.value = saved.apiKey;
                timeoutInput.value = String(Math.round(saved.metadataTimeoutMs / 1000));
                setStatus('设置已保存。', 'success');
            } catch (error) {
                setStatus(error?.message || String(error), 'error');
            }
        });
        testButton.addEventListener('click', async () => {
            testButton.disabled = true;
            setStatus('正在连接 qBittorrent…');
            try {
                const normalized = {
                    ...formSettings(),
                    url: normalizeQbUrl(urlInput.value),
                    apiKey: apiKeyInput.value.trim(),
                };
                const result = await testQbConnection(normalized);
                setStatus(`连接成功，qBittorrent ${result.version}`, 'success');
            } catch (error) {
                setStatus(error?.message || String(error), 'error');
            } finally {
                testButton.disabled = false;
            }
        });

        panel.append(title, description, enabledLabel, urlLabel, apiKeyLabel, timeoutLabel, actions, status);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        urlInput.focus();
        return overlay;
    }

    async function showQbConnectionResult() {
        try {
            const result = await testQbConnection();
            globalThis.alert?.(`qBittorrent 连接成功\n版本：${result.version}`);
        } catch (error) {
            globalThis.alert?.(`qBittorrent 连接失败\n${error?.message || error}`);
        }
    }

    function registerQbMenuCommands() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        GM_registerMenuCommand('⚙️ qBittorrent 设置', openQbSettings);
        GM_registerMenuCommand('🔌 测试 qBittorrent 连接', showQbConnectionResult);
    }

    function createTorrentButton(hash, magnet = '') {
        const button = document.createElement('a');
        button.href = torrentUrl(hash);
        button.textContent = CONFIG.buttonText;
        button.target = '_blank';
        button.rel = 'noopener noreferrer';
        button.referrerPolicy = 'no-referrer';
        button.className = 'mtt-button';
        button.dataset.hash = hash;
        if (magnet) button.dataset.magnet = magnet;
        button.setAttribute(OWNED_ATTR, '');
        button.setAttribute('aria-label', `下载种子 ${hash}`);
        button.addEventListener('click', async event => {
            event.preventDefault();
            if (button.dataset.downloading === 'true') return;
            button.dataset.downloading = 'true';
            button.setAttribute('aria-disabled', 'true');
            const originalText = button.textContent;
            button.textContent = '⏳ 查询缓存';
            try {
                const filename = await downloadTorrent(hash, magnet, stage => {
                    button.textContent = stage === 'qbittorrent' ? '🔎 qB 查元数据' : '⏳ 查询缓存';
                });
                button.textContent = '✅ 已下载';
                button.title = filename;
            } catch (error) {
                console.error('[磁力转种子] 下载失败：', error);
                button.textContent = '❌ 下载失败';
                button.title = error?.message || String(error);
            } finally {
                setTimeout(() => {
                    button.textContent = originalText;
                    button.removeAttribute('aria-disabled');
                    delete button.dataset.downloading;
                }, 1800);
            }
        });
        return button;
    }

    function collect(root, selector) {
        const elements = [];
        if (root.nodeType === Node.ELEMENT_NODE && root.matches(selector)) elements.push(root);
        if (root.querySelectorAll) elements.push(...root.querySelectorAll(selector));
        return elements;
    }

    function handleMagnetLinks(root) {
        for (const link of collect(root, 'a[href]')) {
            if (link.hasAttribute(OWNED_ATTR) || link.hasAttribute(PROCESSED_ATTR)) continue;
            const href = link.getAttribute('href') || '';
            if (!href.toLowerCase().startsWith('magnet:')) continue;
            const hash = extractHash(href);
            if (!hash) continue;

            link.setAttribute(PROCESSED_ATTR, '');
            const next = link.nextElementSibling;
            if (next?.hasAttribute(OWNED_ATTR) && next.dataset.hash === hash) continue;
            link.after(createTorrentButton(hash, href));
        }
    }

    function handleCodeBlocks(root) {
        for (const block of collect(root, CODE_SELECTOR)) {
            if (block.hasAttribute(PROCESSED_ATTR) || block.closest(`[${OWNED_ATTR}]`)) continue;
            if (block.parentElement?.closest(CODE_SELECTOR)) continue;

            const magnets = findMagnets(block.textContent || '');
            block.setAttribute(PROCESSED_ATTR, '');
            if (!magnets.length) continue;

            const buttons = document.createElement('span');
            buttons.className = 'mtt-code-buttons';
            buttons.setAttribute(OWNED_ATTR, '');
            const uniqueMagnets = new Map();
            for (const { hash, magnet } of magnets) {
                if (!uniqueMagnets.has(hash)) uniqueMagnets.set(hash, magnet);
            }
            for (const [hash, magnet] of uniqueMagnets) buttons.appendChild(createTorrentButton(hash, magnet));
            block.after(buttons);
        }
    }

    function handleTextNodes(root) {
        if (!root || root.nodeType === Node.TEXT_NODE && !root.parentElement) return;
        const walkerRoot = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
        if (!walkerRoot || walkerRoot.closest?.(SKIP_SELECTOR) || walkerRoot.closest?.(CODE_SELECTOR)) return;

        const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue?.toLowerCase().includes('magnet:')) return NodeFilter.FILTER_REJECT;
                const parent = node.parentElement;
                if (!parent || parent.closest(SKIP_SELECTOR) || parent.closest(CODE_SELECTOR)) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });

        const nodes = [];
        if (root.nodeType === Node.TEXT_NODE && walker.filter.acceptNode(root) === NodeFilter.FILTER_ACCEPT) {
            nodes.push(root);
        } else {
            while (walker.nextNode()) nodes.push(walker.currentNode);
        }

        for (const textNode of nodes) {
            const text = textNode.nodeValue || '';
            const matches = findMagnets(text);
            if (!matches.length) continue;

            const fragment = document.createDocumentFragment();
            let cursor = 0;
            for (const { magnet, hash, index } of matches) {
                if (index > cursor) fragment.append(text.slice(cursor, index));

                const wrapper = document.createElement('span');
                wrapper.setAttribute(OWNED_ATTR, '');
                const magnetLink = document.createElement('a');
                magnetLink.href = magnet;
                magnetLink.textContent = magnet;
                magnetLink.className = 'mtt-magnet';
                magnetLink.rel = 'noreferrer';
                wrapper.append(magnetLink, createTorrentButton(hash, magnet));
                fragment.append(wrapper);
                cursor = index + magnet.length;
            }
            if (cursor < text.length) fragment.append(text.slice(cursor));
            textNode.replaceWith(fragment);
        }
    }

    function scan(root = document.body) {
        if (!root || root.nodeType === Node.ELEMENT_NODE && root.closest(`[${OWNED_ATTR}]`)) return;
        injectStyles();
        handleMagnetLinks(root);
        handleCodeBlocks(root);
        handleTextNodes(root);
    }

    let timer = null;
    const pendingRoots = new Set();
    function schedule(root) {
        pendingRoots.add(root?.nodeType === Node.TEXT_NODE ? root.parentElement : root);
        clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            const roots = [...pendingRoots];
            pendingRoots.clear();
            for (const candidate of roots) {
                if (candidate?.isConnected) scan(candidate);
            }
        }, CONFIG.debounceMs);
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.target.parentElement?.closest?.(`[${OWNED_ATTR}]`)) continue;
            if (mutation.type === 'characterData') {
                schedule(mutation.target);
            } else {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) schedule(node);
                }
            }
        }
    });

    function start() {
        if (!document.body) return;
        const initialScan = () => scan(document.body);
        if ('requestIdleCallback' in window) window.requestIdleCallback(initialScan, { timeout: 500 });
        else setTimeout(initialScan, 0);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    if (globalThis.__MAGNET_TO_TORRENT_TEST_MODE__) {
        globalThis.__MAGNET_TO_TORRENT_TEST__ = {
            downloadTorrent,
            extractHash,
            findMagnets,
            getQbSettings,
            normalizeHash,
            normalizeQbUrl,
            openQbSettings,
            parseTorrentName,
            requestQb,
            requestTorrent,
            requestTorrentViaQbittorrent,
            saveQbSettings,
            scan,
            stop: () => observer.disconnect(),
            testQbConnection,
            torrentFilename,
            torrentUrl,
            verifyTorrentHash,
        };
    }

    registerQbMenuCommands();
    start();
})();
