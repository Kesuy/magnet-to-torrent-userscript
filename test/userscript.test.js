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

function boot(body, globals = {}, url = 'https://example.com/topic') {
    const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, {
        runScripts: 'dangerously',
        url,
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

test('metadata 授权所有下载源及 iTorrents 重定向域名', () => {
    assert.match(source, /^\/\/ @connect\s+itorrents\.net$/m);
    assert.match(source, /^\/\/ @connect\s+torrage\.info$/m);
    assert.match(source, /^\/\/ @connect\s+\*$/m);
    assert.match(source, /^\/\/ @grant\s+GM_getValue$/m);
    assert.match(source, /^\/\/ @grant\s+GM_setValue$/m);
    assert.match(source, /^\/\/ @grant\s+GM_registerMenuCommand$/m);
});

test('规范化并持久化 qBittorrent WebUI 设置', () => {
    const stored = new Map();
    const { dom, api } = boot('', {
        GM_getValue(key, fallback) { return stored.has(key) ? stored.get(key) : fallback; },
        GM_setValue(key, value) { stored.set(key, value); },
    });

    assert.equal(api.getQbSettings().url, 'http://127.0.0.1:8080');
    assert.equal(api.getQbSettings().enabled, false);
    const saved = api.saveQbSettings({
        enabled: true, url: 'http://localhost:8080/',
        username: 'admin', password: 'secret', metadataTimeoutMs: 15000,
    });
    assert.equal(saved.url, 'http://localhost:8080');
    assert.equal(saved.metadataTimeoutMs, 15000);
    assert.equal(api.getQbSettings().password, 'secret');
    assert.equal(api.getQbSettings().enabled, true);
    assert.throws(() => api.normalizeQbUrl('file:///tmp/rpc'), /仅支持 http 或 https/);
    dom.window.close();
});

test('通过 WebUI 登录并获取 qBittorrent 版本', async () => {
    const requests = [];
    const { dom, api } = boot('', {
        GM_xmlhttpRequest(options) {
            requests.push(options);
            queueMicrotask(() => options.onload({
                status: 200,
                responseText: options.url.endsWith('/auth/login') ? 'Ok.' : '5.2.3',
            }));
        },
    });

    const result = await api.testQbConnection({
        enabled: true, url: 'http://localhost:8080', username: 'admin', password: 'rpc-token',
    });
    assert.equal(result.version, '5.2.3');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, 'http://localhost:8080/api/v2/auth/login');
    assert.equal(requests[0].data, 'username=admin&password=rpc-token');
    assert.equal(requests[1].url, 'http://localhost:8080/api/v2/app/version');
    dom.window.close();
});

test('qBittorrent 与 BTSOW 菜单可打开设置面板', () => {
    const commands = [];
    const stored = new Map();
    const { dom, document } = boot('', {
        GM_getValue(key, fallback) { return stored.has(key) ? stored.get(key) : fallback; },
        GM_setValue(key, value) { stored.set(key, value); },
        GM_registerMenuCommand(label, callback) { commands.push({ label, callback }); },
    });

    assert.deepEqual(commands.map(command => command.label), [
        '⚙️ qBittorrent 设置',
        '🔌 测试 qBittorrent 登录',
        '🌐 BTSOW 域名设置',
    ]);
    commands[0].callback();
    const qbDialog = document.querySelector('#mtt-qb-dialog [role="dialog"]');
    assert.ok(qbDialog);
    assert.equal(qbDialog.querySelector('input[name="qb-url"]').value, 'http://127.0.0.1:8080');

    commands[2].callback();
    const dialog = document.querySelector('#mtt-btsow-dialog [role="dialog"]');
    assert.ok(dialog);
    const field = dialog.querySelector('textarea[name="btsow-domains"]');
    assert.equal(field.value, 'btsow.live');
    field.value = 'https://btsow.live/\nbtsow.example';
    dialog.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(stored.get('mtt-btsow-domains'), 'btsow.live\nbtsow.example');
    assert.equal(dialog.querySelector('[role="status"]').dataset.kind, 'success');
    dom.window.close();
});

test('BTSOW 域名可编辑、多域名去重并拒绝包含路径的地址', () => {
    const stored = new Map();
    const { dom, api } = boot('', {
        GM_getValue(key, fallback) { return stored.has(key) ? stored.get(key) : fallback; },
        GM_setValue(key, value) { stored.set(key, value); },
    });
    assert.deepEqual([...api.getBtsowDomains()], ['btsow.live']);
    assert.deepEqual([...api.saveBtsowDomains('https://BTSOW.LIVE/, btsow.new\nbtsow.live')], [
        'btsow.live', 'btsow.new',
    ]);
    assert.deepEqual([...api.getBtsowDomains()], ['btsow.live', 'btsow.new']);
    assert.throws(() => api.saveBtsowDomains('https://btsow.live/magnet/detail/123'), /不能包含端口、路径或参数/);
    assert.throws(() => api.saveBtsowDomains(''), /至少填写一个/);
    dom.window.close();
});

test('BTSOW 磁力详情页从 textarea 添加唯一的下载按钮', () => {
    const magnet = 'magnet:?xt=urn:btih:' + HEX_HASH + '&dn=Demo';
    const html = '<main><textarea class="magnet-link">' + magnet +
        '</textarea><div class="magnet-action-buttons"></div><a href="' + magnet + '">Open with BT</a></main>';
    const { dom, api, document } = boot(html, {}, 'https://btsow.live/magnet/detail/' + HEX_HASH);
    const field = document.querySelector('textarea.magnet-link');
    assert.equal(buttons(document).length, 1);
    assert.equal(field.nextElementSibling.className, 'mtt-btsow-buttons');
    assert.equal(buttons(document)[0].dataset.magnet, magnet);
    api.scan(document.body);
    assert.equal(buttons(document).length, 1);
    dom.window.close();
});

test('BTSOW 磁力输入值变更后替换按钮，不留下旧的 hash', async () => {
    const first = 'magnet:?xt=urn:btih:' + HEX_HASH;
    const secondHash = '89ABCDEF0123456789ABCDEF0123456789ABCDEF';
    const second = 'magnet:?xt=urn:btih:' + secondHash + '&dn=Next';
    const { dom, document } = boot(
        '<textarea class="magnet-link">' + first + '</textarea>', {},
        'https://btsow.live/magnet/detail/' + HEX_HASH,
    );
    const field = document.querySelector('textarea.magnet-link');
    field.value = second;
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise(resolve => dom.window.setTimeout(resolve, 260));
    assert.equal(buttons(document).length, 1);
    assert.equal(buttons(document)[0].dataset.hash, secondHash);
    assert.equal(buttons(document)[0].dataset.magnet, second);
    dom.window.close();
});

test('BTSOW 适配只作用于设置的域名，新增域名后立即生效', () => {
    const magnet = 'magnet:?xt=urn:btih:' + HEX_HASH;
    const { dom, api, document } = boot(
        '<textarea class="magnet-link">' + magnet + '</textarea>',
        { GM_getValue(key, fallback) { return fallback; }, GM_setValue(key, value) { this._store = [key, value]; } },
        'https://btsow.new/magnet/detail/' + HEX_HASH,
    );
    assert.equal(buttons(document).length, 0);
    api.saveBtsowDomains('btsow.live\nbtsow.new');
    api.scan(document.body);
    assert.equal(buttons(document).length, 1);
    dom.window.close();
});

test('将 32 位 Base32 BTIH 正确转换为 40 位十六进制', () => {
    const { dom, api } = boot('');
    assert.equal(api.normalizeHash(BASE32_HASH), '0123456789ABCDEF0123456789ABCDEF01234567');
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

test('下载时先读取 torrent 元数据，再按实际名称保存 Blob', async () => {
    const events = {};
    const { dom, api } = boot('', {
        GM_xmlhttpRequest(options) {
            events.request = options;
            queueMicrotask(() => options.onload({ status: 200, response: TORRENT_BYTES.buffer }));
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

    const filename = await api.downloadTorrent(TORRENT_HASH);
    assert.equal(events.request.url, `https://itorrents.net/torrent/${TORRENT_HASH}.torrent`);
    assert.equal(events.request.responseType, 'arraybuffer');
    assert.equal(filename, 'My Movie!.torrent');
    assert.deepEqual(events.download, { href: 'blob:test-torrent', filename: 'My Movie!.torrent' });
    assert.equal(events.blob.type, 'application/x-bittorrent');
    await new Promise(resolve => dom.window.setTimeout(resolve, 1100));
    assert.equal(events.revoked, 'blob:test-torrent');
    dom.window.close();
});

test('当前一个缓存源失败时自动尝试下一个源', async () => {
    const requested = [];
    const { dom, api } = boot('', {
        GM_xmlhttpRequest(options) {
            requested.push(options.url);
            if (requested.length < 3) {
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
        `https://torrage.info/torrent.php?h=${TORRENT_HASH}`,
        `https://itorrents.org/torrent/${TORRENT_HASH}.torrent`,
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
