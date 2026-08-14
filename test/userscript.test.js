import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { TextDecoder, TextEncoder } from 'node:util';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../magnet-to-torrent.user.js', import.meta.url), 'utf8');
const HEX_HASH = '0123456789ABCDEF0123456789ABCDEF01234567';
const BASE32_HASH = 'AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH';

function boot(body, globals = {}) {
    const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, {
        runScripts: 'dangerously',
        url: 'https://example.com/topic',
    });
    Object.assign(dom.window, { TextDecoder, TextEncoder }, globals);
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

test('metadata 授权所有下载源及 iTorrents 重定向域名', () => {
    assert.match(source, /^\/\/ @connect\s+itorrents\.net$/m);
    assert.match(source, /^\/\/ @connect\s+torrage\.info$/m);
});

test('将 32 位 Base32 BTIH 正确转换为 40 位十六进制', () => {
    const { dom, api } = boot('');
    assert.equal(api.normalizeHash(BASE32_HASH), '0123456789ABCDEF0123456789ABCDEF01234567');
    dom.window.close();
});

test('从 torrent 的 info.name 中解析实际名称', () => {
    const { dom, api } = boot('');
    const torrent = encode('d4:infod4:name9:My Movie!ee');
    assert.equal(api.parseTorrentName(torrent), 'My Movie!');
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

test('下载时先读取 torrent 元数据，再按实际名称保存 Blob', async () => {
    const torrent = encode('d4:infod4:name9:My Movie!ee');
    const events = {};
    const { dom, api } = boot('', {
        GM_xmlhttpRequest(options) {
            events.request = options;
            queueMicrotask(() => options.onload({ status: 200, response: torrent.buffer }));
        },
    });
    dom.window.URL.createObjectURL = blob => {
        events.blob = blob;
        return 'blob:test-torrent';
    };
    dom.window.URL.revokeObjectURL = url => { events.revoked = url; };
    dom.window.HTMLAnchorElement.prototype.click = function () {
        events.download = { href: this.href, filename: this.download };
    };

    const filename = await api.downloadTorrent(HEX_HASH);
    assert.equal(events.request.url, `https://itorrents.net/torrent/${HEX_HASH}.torrent`);
    assert.equal(events.request.responseType, 'arraybuffer');
    assert.equal(filename, 'My Movie!.torrent');
    assert.deepEqual(events.download, { href: 'blob:test-torrent', filename: 'My Movie!.torrent' });
    assert.equal(events.blob.type, 'application/x-bittorrent');
    await new Promise(resolve => dom.window.setTimeout(resolve, 1100));
    assert.equal(events.revoked, 'blob:test-torrent');
    dom.window.close();
});

test('当前一个缓存源失败时自动尝试下一个源', async () => {
    const torrent = encode('d4:infod4:name9:My Movie!ee');
    const requested = [];
    const { dom, api } = boot('', {
        GM_xmlhttpRequest(options) {
            requested.push(options.url);
            if (requested.length < 3) {
                queueMicrotask(() => options.onload({ status: 404, response: new ArrayBuffer(0) }));
            } else {
                queueMicrotask(() => options.onload({ status: 200, response: torrent.buffer }));
            }
        },
    });

    const bytes = await api.requestTorrent(HEX_HASH);
    assert.equal(api.parseTorrentName(bytes), 'My Movie!');
    assert.deepEqual(requested, [
        `https://itorrents.net/torrent/${HEX_HASH}.torrent`,
        `https://torrage.info/torrent/${HEX_HASH}.torrent`,
        `https://itorrents.org/torrent/${HEX_HASH}.torrent`,
    ]);
    dom.window.close();
});

test('为 magnet 链接添加一个安全的 torrent 按钮且重复扫描不重复', () => {
    const { dom, api, document } = boot(`<a id="magnet" href="magnet:?xt=urn:btih:${HEX_HASH}&dn=demo">下载</a>`);
    assert.equal(buttons(document).length, 1);
    assert.equal(buttons(document)[0].href, `https://itorrents.net/torrent/${HEX_HASH}.torrent`);
    assert.equal(buttons(document)[0].rel, 'noopener noreferrer');
    assert.equal(buttons(document)[0].referrerPolicy, 'no-referrer');
    api.scan(document.body);
    assert.equal(buttons(document).length, 1);
    dom.window.close();
});

test('把纯文本 magnet 变成可点击链接并保留前后文本', () => {
    const { dom, document } = boot(`<p id="text">前缀 magnet:?xt=urn:btih:${HEX_HASH}&dn=demo 后缀</p>`);
    const paragraph = document.querySelector('#text');
    assert.match(paragraph.textContent, /^前缀 magnet:/);
    assert.match(paragraph.textContent, / 后缀$/);
    assert.equal(paragraph.querySelector('a.mtt-magnet').protocol, 'magnet:');
    assert.equal(buttons(document).length, 1);
    dom.window.close();
});

test('同一文本中重复出现的 magnet 都可点击', () => {
    const magnet = `magnet:?xt=urn:btih:${HEX_HASH}`;
    const { dom, document } = boot(`<p>${magnet} 与 ${magnet}</p>`);
    assert.equal(document.querySelectorAll('a.mtt-magnet').length, 2);
    assert.equal(buttons(document).length, 2);
    dom.window.close();
});

test('代码块中多个 hash 各生成一个按钮，嵌套 code 不重复', () => {
    const secondHash = '89ABCDEF0123456789ABCDEF0123456789ABCDEF';
    const { dom, document } = boot(`<pre><code>magnet:?xt=urn:btih:${HEX_HASH}\nmagnet:?xt=urn:btih:${secondHash}</code></pre>`);
    assert.equal(buttons(document).length, 2);
    dom.window.close();
});

test('忽略输入框、脚本和不可用 hash', () => {
    const { dom, document } = boot(`<textarea>magnet:?xt=urn:btih:${HEX_HASH}</textarea><script>"magnet:?xt=urn:btih:${HEX_HASH}"</script><p>magnet:?xt=urn:btih:INVALID</p>`);
    assert.equal(buttons(document).length, 0);
    dom.window.close();
});

test('动态插入内容只处理新增子树', async () => {
    const { dom, document } = boot('<main id="root"></main>');
    const item = document.createElement('p');
    item.textContent = `新增 magnet:?xt=urn:btih:${BASE32_HASH}`;
    document.querySelector('#root').append(item);
    await new Promise(resolve => dom.window.setTimeout(resolve, 260));
    assert.equal(buttons(document).length, 1);
    assert.match(buttons(document)[0].href, new RegExp(`${HEX_HASH}\\.torrent$`));
    dom.window.close();
});
