// ==UserScript==
// @name         磁力链接转种子下载
// @namespace    https://github.com/Kesuy/magnet-to-torrent-userscript
// @version      3.2.0
// @description  识别页面中的磁力链接，按种子实际名称下载 .torrent 文件
// @author       Kesuy
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      itorrents.net
// @connect      itorrents.org
// @connect      torrage.info
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
        ]),
        buttonText: '📥 种子',
        debounceMs: 180,
        aria2: Object.freeze({
            defaultUrl: 'http://127.0.0.1:6800/jsonrpc',
            requestTimeoutMs: 10000,
            urlStorageKey: 'mtt-aria2-rpc-url',
            secretStorageKey: 'mtt-aria2-rpc-secret',
        }),
    });

    const OWNED_ATTR = 'data-mtt-owned';
    const PROCESSED_ATTR = 'data-mtt-processed';
    const STYLE_ID = 'mtt-styles';
    const ARIA2_DIALOG_ID = 'mtt-aria2-dialog';
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

    function normalizeAria2Url(value) {
        const raw = String(value || '').trim();
        if (!raw) throw new Error('请输入 aria2 RPC 地址');

        let url;
        try {
            url = new URL(raw);
        } catch {
            throw new Error('aria2 RPC 地址格式无效');
        }
        if (!['http:', 'https:'].includes(url.protocol)) {
            throw new Error('aria2 RPC 地址仅支持 http 或 https');
        }
        if (url.username || url.password) {
            throw new Error('请不要把用户名或密码写入 aria2 RPC 地址');
        }
        if (!url.hostname) throw new Error('aria2 RPC 地址缺少主机名');
        if (url.pathname === '/' || !url.pathname) url.pathname = '/jsonrpc';
        url.hash = '';
        return url.toString();
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

    function getAria2Settings() {
        const url = getStoredValue(CONFIG.aria2.urlStorageKey, CONFIG.aria2.defaultUrl);
        const secret = getStoredValue(CONFIG.aria2.secretStorageKey, '');
        return { url: String(url || CONFIG.aria2.defaultUrl), secret: String(secret || '') };
    }

    function saveAria2Settings(settings) {
        const normalized = {
            url: normalizeAria2Url(settings?.url),
            secret: String(settings?.secret || '').trim(),
        };
        setStoredValue(CONFIG.aria2.urlStorageKey, normalized.url);
        setStoredValue(CONFIG.aria2.secretStorageKey, normalized.secret);
        return normalized;
    }

    function requestAria2(method, params = [], settings = getAria2Settings()) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('当前 userscript 管理器不支持 GM_xmlhttpRequest'));
                return;
            }

            let url;
            try {
                url = normalizeAria2Url(settings.url);
            } catch (error) {
                reject(error);
                return;
            }
            const secret = String(settings.secret || '').trim();
            const rpcParams = secret ? [`token:${secret}`, ...params] : [...params];
            const requestId = `mtt-${Date.now()}-${Math.random().toString(16).slice(2)}`;

            GM_xmlhttpRequest({
                method: 'POST',
                url,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params: rpcParams }),
                responseType: 'json',
                timeout: CONFIG.aria2.requestTimeoutMs,
                anonymous: true,
                onload(response) {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`aria2 连接失败（HTTP ${response.status}）`));
                        return;
                    }
                    let body = response.response;
                    if (!body && response.responseText) {
                        try {
                            body = JSON.parse(response.responseText);
                        } catch {
                            reject(new Error('aria2 返回的不是有效 JSON'));
                            return;
                        }
                    }
                    if (!body || typeof body !== 'object') {
                        reject(new Error('aria2 返回内容为空'));
                        return;
                    }
                    if (body.error) {
                        const code = body.error.code ?? '未知';
                        reject(new Error(`aria2 RPC 错误 ${code}：${body.error.message || '未知错误'}`));
                        return;
                    }
                    resolve(body.result);
                },
                onerror: () => reject(new Error('无法连接 aria2，请检查地址、服务状态和跨域权限')),
                ontimeout: () => reject(new Error('连接 aria2 超时')),
            });
        });
    }

    async function testAria2Connection(settings = getAria2Settings()) {
        const result = await requestAria2('aria2.getVersion', [], settings);
        if (!result?.version) throw new Error('aria2 已响应，但未返回版本号');
        return {
            version: String(result.version),
            enabledFeatures: Array.isArray(result.enabledFeatures) ? result.enabledFeatures : [],
        };
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
                timeout: 30000,
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

    async function requestTorrent(hash) {
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
        throw new Error(`所有 torrent 缓存源均不可用：${errors.join('；')}`);
    }

    async function downloadTorrent(hash) {
        const bytes = await requestTorrent(hash);
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
            .mtt-aria2-overlay { position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center;
                justify-content:center; padding:20px; background:rgba(0,0,0,.5); font:14px/1.5 sans-serif; }
            .mtt-aria2-panel { width:min(520px, 100%); box-sizing:border-box; padding:20px; border-radius:10px;
                background:#fff; color:#222; box-shadow:0 12px 40px rgba(0,0,0,.3); }
            .mtt-aria2-panel h2 { margin:0 0 8px; font-size:20px; }
            .mtt-aria2-panel p { margin:0 0 14px; color:#555; }
            .mtt-aria2-field { display:block; margin:12px 0; font-weight:600; }
            .mtt-aria2-field input { display:block; width:100%; box-sizing:border-box; margin-top:5px; padding:8px 10px;
                border:1px solid #bbb; border-radius:5px; background:#fff; color:#222; font:14px/1.4 monospace; }
            .mtt-aria2-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:16px; }
            .mtt-aria2-actions button { padding:7px 14px; border:1px solid #aaa; border-radius:5px; cursor:pointer; }
            .mtt-aria2-actions button[type="submit"] { border-color:#1677ff; background:#1677ff; color:#fff; }
            .mtt-aria2-status { min-height:21px; margin-top:12px; color:#555; overflow-wrap:anywhere; }
            .mtt-aria2-status[data-kind="success"] { color:#16803c; }
            .mtt-aria2-status[data-kind="error"] { color:#c5221f; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function openAria2Settings() {
        if (!document.body) throw new Error('页面尚未加载完成');
        document.getElementById(ARIA2_DIALOG_ID)?.remove();
        injectStyles();

        const current = getAria2Settings();
        const overlay = document.createElement('div');
        overlay.id = ARIA2_DIALOG_ID;
        overlay.className = 'mtt-aria2-overlay';
        overlay.setAttribute(OWNED_ATTR, '');

        const panel = document.createElement('form');
        panel.className = 'mtt-aria2-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'mtt-aria2-title');

        const title = document.createElement('h2');
        title.id = 'mtt-aria2-title';
        title.textContent = 'aria2 RPC 设置';
        const description = document.createElement('p');
        description.textContent = '测试连接只调用只读方法 aria2.getVersion，不会添加下载任务。';

        const urlLabel = document.createElement('label');
        urlLabel.className = 'mtt-aria2-field';
        urlLabel.textContent = 'RPC 地址';
        const urlInput = document.createElement('input');
        urlInput.name = 'aria2-url';
        urlInput.type = 'url';
        urlInput.required = true;
        urlInput.value = current.url;
        urlInput.placeholder = CONFIG.aria2.defaultUrl;
        urlInput.autocomplete = 'url';
        urlLabel.appendChild(urlInput);

        const secretLabel = document.createElement('label');
        secretLabel.className = 'mtt-aria2-field';
        secretLabel.textContent = 'RPC 密钥（可选）';
        const secretInput = document.createElement('input');
        secretInput.name = 'aria2-secret';
        secretInput.type = 'password';
        secretInput.value = current.secret;
        secretInput.placeholder = '对应 aria2 的 rpc-secret';
        secretInput.autocomplete = 'off';
        secretLabel.appendChild(secretInput);

        const status = document.createElement('div');
        status.className = 'mtt-aria2-status';
        status.setAttribute('aria-live', 'polite');
        const setStatus = (message, kind = '') => {
            status.textContent = message;
            status.dataset.kind = kind;
        };
        const formSettings = () => ({ url: urlInput.value, secret: secretInput.value });

        const actions = document.createElement('div');
        actions.className = 'mtt-aria2-actions';
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
                const saved = saveAria2Settings(formSettings());
                urlInput.value = saved.url;
                secretInput.value = saved.secret;
                setStatus('设置已保存。', 'success');
            } catch (error) {
                setStatus(error?.message || String(error), 'error');
            }
        });
        testButton.addEventListener('click', async () => {
            testButton.disabled = true;
            setStatus('正在连接 aria2…');
            try {
                const result = await testAria2Connection(formSettings());
                const features = result.enabledFeatures.length ? `；功能：${result.enabledFeatures.join(', ')}` : '';
                setStatus(`连接成功，aria2 ${result.version}${features}`, 'success');
            } catch (error) {
                setStatus(error?.message || String(error), 'error');
            } finally {
                testButton.disabled = false;
            }
        });

        panel.append(title, description, urlLabel, secretLabel, actions, status);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        urlInput.focus();
        return overlay;
    }

    async function showAria2ConnectionResult() {
        try {
            const result = await testAria2Connection();
            globalThis.alert?.(`aria2 连接成功\n版本：${result.version}`);
        } catch (error) {
            globalThis.alert?.(`aria2 连接失败\n${error?.message || error}`);
        }
    }

    function registerAria2MenuCommands() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        GM_registerMenuCommand('⚙️ aria2 设置', openAria2Settings);
        GM_registerMenuCommand('🔌 测试 aria2 连接', showAria2ConnectionResult);
    }

    function createTorrentButton(hash) {
        const button = document.createElement('a');
        button.href = torrentUrl(hash);
        button.textContent = CONFIG.buttonText;
        button.target = '_blank';
        button.rel = 'noopener noreferrer';
        button.referrerPolicy = 'no-referrer';
        button.className = 'mtt-button';
        button.setAttribute(OWNED_ATTR, '');
        button.setAttribute('aria-label', `下载种子 ${hash}`);
        button.addEventListener('click', async event => {
            event.preventDefault();
            if (button.dataset.downloading === 'true') return;
            button.dataset.downloading = 'true';
            button.setAttribute('aria-disabled', 'true');
            const originalText = button.textContent;
            button.textContent = '⏳ 读取名称';
            try {
                const filename = await downloadTorrent(hash);
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
            if (next?.hasAttribute(OWNED_ATTR) && next.href === torrentUrl(hash)) continue;
            link.after(createTorrentButton(hash));
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
            const uniqueHashes = new Set(magnets.map(({ hash }) => hash));
            for (const hash of uniqueHashes) buttons.appendChild(createTorrentButton(hash));
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
                wrapper.append(magnetLink, createTorrentButton(hash));
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
            getAria2Settings,
            normalizeHash,
            normalizeAria2Url,
            openAria2Settings,
            parseTorrentName,
            requestAria2,
            requestTorrent,
            saveAria2Settings,
            scan,
            stop: () => observer.disconnect(),
            testAria2Connection,
            torrentFilename,
            torrentUrl,
            verifyTorrentHash,
        };
    }

    registerAria2MenuCommands();
    start();
})();
