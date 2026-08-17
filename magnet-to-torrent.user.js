// ==UserScript==
// @name         磁力链接转种子下载
// @namespace    https://github.com/Kesuy/magnet-to-torrent-userscript
// @version      3.1.2
// @description  识别页面中的磁力链接，按种子实际名称下载 .torrent 文件
// @author       Kesuy
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @connect      itorrents.net
// @connect      itorrents.org
// @connect      torrage.info
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
    });

    const OWNED_ATTR = 'data-mtt-owned';
    const PROCESSED_ATTR = 'data-mtt-processed';
    const STYLE_ID = 'mtt-styles';
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
        `;
        (document.head || document.documentElement).appendChild(style);
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
            normalizeHash,
            parseTorrentName,
            requestTorrent,
            scan,
            stop: () => observer.disconnect(),
            torrentFilename,
            torrentUrl,
            verifyTorrentHash,
        };
    }

    start();
})();
