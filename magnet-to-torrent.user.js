// ==UserScript==
// @name         磁力链接转种子下载
// @namespace    https://github.com/Kesuy/magnet-to-torrent-userscript
// @version      3.0.0
// @description  识别页面中的磁力链接，并添加轻量、无重复的 .torrent 下载按钮
// @author       Kesuy
// @match        *://*/*
// @grant        none
// @run-at       document-end
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/Kesuy/magnet-to-torrent-userscript/main/magnet-to-torrent.user.js
// @downloadURL  https://raw.githubusercontent.com/Kesuy/magnet-to-torrent-userscript/main/magnet-to-torrent.user.js
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = Object.freeze({
        torrentCache: 'https://itorrents.org/torrent/',
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
        return `${CONFIG.torrentCache}${hash}.torrent`;
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
            extractHash,
            findMagnets,
            normalizeHash,
            scan,
            stop: () => observer.disconnect(),
            torrentUrl,
        };
    }

    start();
})();
