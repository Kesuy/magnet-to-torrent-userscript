import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { TextDecoder, TextEncoder } from 'node:util';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../magnet-to-torrent.user.js', import.meta.url), 'utf8');
const HEX_HASH = '0123456789ABCDEF0123456789ABCDEF01234567';
const BASE32_HASH = 'AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH';
const TORRENT_INFO = new TextEncoder().encode('d4:name9:My Movie!e');
const TORRENT_BYTES = new TextEncoder().encode('d4:infod4:name9:My Movie!ee');
const TORRENT_HASH = createHash('sha1').update(TORRENT_INFO).digest('hex').toUpperCase();

function boot(body = '', globals = {}) {
    const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, {
        runScripts: 'dangerously',
        url: 'https://example.com/topic',
    });
    Object.assign(dom.window, { TextDecoder, TextEncoder }, globals);
    Object.defineProperty(dom.window, 'crypto', { configurable: true, value: webcrypto });
    dom.window.__MAGNET_TO_TORRENT_TEST_MODE__ = true;
    dom.window.eval(source);
    const api = dom.window.__MAGNET_TO_TORRENT_TEST__;
    api.scan(dom.window.document.body);
    return { dom, api, document: dom.window.document };
}

function buttons(document) {
    return [...document.querySelectorAll('a.mtt-button')];
}

function encode(value) {
    return new TextEncoder().encode(value);
}

test('4.0 metadata 包含 BTCache/qB 权限且彻底移除 aria2', () => {
    assert.match(source, /^\/\/ @version\s+4\.0\.0$/m);
    assert.match(source, /^\/\/ @connect\s+btcache\.me$/m);
    assert.match(source, /^\/\/ @connect\s+\*$/m);
    assert.match(source, /^\/\/ @grant\s+GM_getValue$/m);
    assert.match(source, /^\/\/ @grant\s+GM_setValue$/m);
    assert.match(source, /^\/\/ @grant\s+GM_registerMenuCommand$/m);
    assert.doesNotMatch(source, /aria2/i);
});

test('规范化并持久化 qBittorrent 设置', () => {
    const stored = new Map();
    const { dom, api } = boot('', {
        GM_getValue(key, fallback) { return stored.has(key) ? stored.get(key) : fallback; },
        GM_setValue(key, value) { stored.set(key, value); },
    });

    assert.deepEqual(JSON.parse(JSON.stringify(api.getQbSettings())), {
        enabled: false,
        url: 'http://127.0.0.1:8080',
        apiKey: '',
        metadataTimeoutMs: 60000,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(api.saveQbSettings({
        enabled: true,
        url: 'http://localhost:8080/',
        apiKey: ' key-123 ',
        metadataTimeoutMs: 90000,
    }))), {
        enabled: true,
        url: 'http://localhost:8080',
        apiKey: 'key-123',
        metadataTimeoutMs: 90000,
    });
    assert.throws(() => api.normalizeQbUrl('file:///tmp/qb'), /仅支持 http 或 https/);
    dom.window.close();
});

test('使用 Bearer API Key 测试 qBittorrent 连接', async () => {
    let request;
    const { dom, api } = boot('', {
        GM_xmlhttpRequest(options) {
            request = options;
            queueMicrotask(() => options.onload({ status: 200, responseText: '5.1.4' }));
        },
    });

    const result = await api.testQbConnection({
        enabled: true,
        url: 'http://localhost:8080',
        apiKey: 'test-key',
        metadataTimeoutMs: 60000,
    });
    assert.equal(request.url, 'http://localhost:8080/api/v2/app/version');
    assert.equal(request.headers.Authorization, 'Bearer test-key');
    assert.equal(result.version, '5.1.4');
    dom.window.close();
});

test('qB metadata resolver 使用完整 magnet 并导出已校验 torrent', async () => {
    const magnet = `magnet:?xt=urn:btih:${TORRENT_HASH}&dn=demo&tr=${encodeURIComponent('udp://tracker.example:80/announce')}`;
    const requested = [];
    const { dom, api } = boot('', {
        GM_xmlhttpRequest(options) {
            requested.push(options);
            if (options.url.includes('/fetchMetadata?')) {
                queueMicrotask(() => options.onload({ status: 200, responseText: '{}' }));
                return;
            }
            if (options.url.includes('/saveMetadata?')) {
                queueMicrotask(() => options.onload({ status: 200, response: TORRENT_BYTES.buffer }));
                return;
            }
            throw new Error(`unexpected URL ${options.url}`);
        },
    });

    const bytes = await api.requestTorrentViaQbittorrent(TORRENT_HASH, magnet, {
        enabled: true,
        url: 'http://localhost:8080',
        apiKey: 'key',
        metadataTimeoutMs: 10000,
    });
    assert.equal(api.parseTorrentName(bytes), 'My Movie!');
    assert.equal(requested.length, 2);
    assert.match(decodeURIComponent(requested[0].url), /dn=demo/);
    assert.match(decodeURIComponent(requested[0].url), /udp:\/\/tracker\.example:80\/announce/);
    assert.ok(requested[0].url.includes('/api/v2/torrents/fetchMetadata?source='));
    assert.ok(requested[1].url.includes('/api/v2/torrents/saveMetadata?source='));
    dom.window.close();
});

test('四个公共缓存源按顺序回退，包含 BTCache', async () => {
    const requested = [];
    const { dom, api } = boot('', {
        GM_xmlhttpRequest(options) {
            requested.push(options.url);
            if (requested.length < 4) {
                queueMicrotask(() => options.onload({ status: 404, response: new ArrayBuffer(0) }));
            } else {
                queueMicrotask(() => options.onload({ status: 200, response: TORRENT_BYTES.buffer }));
            }
        },
    });

    const bytes = await api.requestTorrent(TORRENT_HASH);
    assert.equal(api.parseTorrentName(bytes), 'My Movie!');
    assert.deepEqual(requested, [
        `https://itorrents.net/torrent/${TORRENT_HASH}.torrent`,
        `https://torrage.info/torrent/${TORRENT_HASH}.torrent`,
        `https://itorrents.org/torrent/${TORRENT_HASH}.torrent`,
        `https://btcache.me/torrent/${TORRENT_HASH}`,
    ]);
    dom.window.close();
});

test('缓存全失败且 qB 已启用时自动进入 metadata resolver', async () => {
    const stored = new Map([
        ['mtt-qb-enabled', true],
        ['mtt-qb-url', 'http://localhost:8080'],
        ['mtt-qb-api-key', 'key'],
        ['mtt-qb-metadata-timeout-ms', 10000],
    ]);
    const requested = [];
    const magnet = `magnet:?xt=urn:btih:${TORRENT_HASH}&dn=fallback`;
    const { dom, api } = boot('', {
        GM_getValue(key, fallback) { return stored.has(key) ? stored.get(key) : fallback; },
        GM_xmlhttpRequest(options) {
            requested.push(options.url);
            if (options.url.startsWith('https://')) {
                queueMicrotask(() => options.onload({ status: 404, response: new ArrayBuffer(0) }));
            } else if (options.url.includes('/fetchMetadata?')) {
                queueMicrotask(() => options.onload({ status: 200, responseText: '{}' }));
            } else if (options.url.includes('/saveMetadata?')) {
                queueMicrotask(() => options.onload({ status: 200, response: TORRENT_BYTES.buffer }));
            }
        },
    });

    const stages = [];
    const bytes = await api.requestTorrent(TORRENT_HASH, magnet, stage => stages.push(stage));
    assert.equal(api.parseTorrentName(bytes), 'My Movie!');
    assert.deepEqual(stages, ['cache', 'qbittorrent']);
    assert.ok(requested.some(url => url.includes('/fetchMetadata?')));
    assert.ok(requested.some(url => url.includes('/saveMetadata?')));
    dom.window.close();
});

test('将 32 位 Base32 BTIH 正确转换为 40 位十六进制', () => {
    const { dom, api } = boot('');
    assert.equal(api.normalizeHash(BASE32_HASH), HEX_HASH);
    dom.window.close();
});

test('从 torrent 的 info.name 中解析实际名称', () => {
    const { dom, api } = boot('');
    assert.equal(api.parseTorrentName(TORRENT_BYTES), 'My Movie!');
    dom.window.close();
});

test('拒绝 infohash 与请求 hash 不一致的 torrent', async () => {
    const { dom, api } = boot('');
    await assert.rejects(api.verifyTorrentHash(TORRENT_BYTES, HEX_HASH), /infohash 不匹配/);
    await assert.doesNotReject(api.verifyTorrentHash(TORRENT_BYTES, TORRENT_HASH));
    dom.window.close();
});

test('优先读取 UTF-8 名称并清理 Windows 非法文件名字符', () => {
    const { dom, api } = boot('');
    const actualName = '电影:测试?';
    const byteLength = encode(actualName).length;
    const torrent = encode(`d4:infod10:name.utf-8${byteLength}:${actualName}4:name11:Legacy Nameee`);
    assert.equal(api.torrentFilename(torrent, HEX_HASH), '电影：测试？.torrent');
    dom.window.close();
});

test('magnet 链接按钮保留完整 magnet，重复扫描不重复', () => {
    const magnet = `magnet:?xt=urn:btih:${HEX_HASH}&dn=demo&tr=${encodeURIComponent('udp://tracker.example/announce')}`;
    const { dom, api, document } = boot(`<a id="magnet" href="${magnet}">下载</a>`);
    assert.equal(buttons(document).length, 1);
    assert.equal(buttons(document)[0].dataset.magnet, magnet);
    api.scan(document.body);
    assert.equal(buttons(document).length, 1);
    dom.window.close();
});

test('纯文本 magnet 变成可点击链接并把完整 URI 交给按钮', () => {
    const magnet = `magnet:?xt=urn:btih:${HEX_HASH}&dn=demo`;
    const { dom, document } = boot(`<p id="text">前缀 ${magnet} 后缀</p>`);
    const paragraph = document.querySelector('#text');
    assert.match(paragraph.textContent, /^前缀 magnet:/);
    assert.match(paragraph.textContent, / 后缀$/);
    assert.equal(paragraph.querySelector('a.mtt-magnet').protocol, 'magnet:');
    assert.equal(buttons(document)[0].dataset.magnet, magnet);
    dom.window.close();
});

test('代码块同一 hash 只生成一个按钮并保留首次完整 magnet', () => {
    const magnet1 = `magnet:?xt=urn:btih:${HEX_HASH}&dn=first`;
    const magnet2 = `magnet:?xt=urn:btih:${HEX_HASH}&dn=second`;
    const { dom, document } = boot(`<pre><code>${magnet1}\n${magnet2}</code></pre>`);
    assert.equal(buttons(document).length, 1);
    assert.equal(buttons(document)[0].dataset.magnet, magnet1);
    dom.window.close();
});

test('动态插入内容可识别 magnet', async () => {
    const { dom, document } = boot('<main id="root"></main>');
    const item = document.createElement('p');
    item.textContent = `新增 magnet:?xt=urn:btih:${BASE32_HASH}`;
    document.querySelector('#root').append(item);
    await new Promise(resolve => dom.window.setTimeout(resolve, 260));
    assert.equal(buttons(document).length, 1);
    assert.equal(buttons(document)[0].dataset.hash, HEX_HASH);
    dom.window.close();
});
