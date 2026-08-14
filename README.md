# 磁力链接转种子下载

一个轻量的 Tampermonkey / Violentmonkey 用户脚本。它会识别网页中的 `magnet:` 链接，并在旁边添加 **📥 种子** 按钮，通过 iTorrents 缓存获取对应的 `.torrent` 文件。

## 安装

[点击安装 userscript](https://raw.githubusercontent.com/Kesuy/magnet-to-torrent-userscript/main/magnet-to-torrent.user.js)

需要先安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。

## 3.1.1：修复下载失败并增加多源回退

- 修复 iTorrents 从 `itorrents.org` 重定向到 `itorrents.net` 后，被 userscript 跨域权限拦截的问题。
- 改为直接优先访问实际提供文件的 `itorrents.net`。
- 增加 Torrage 作为独立缓存源，并保留 `itorrents.org` 作为末级回退。
- 当前源返回 404、网络错误或非 torrent 内容时，会自动尝试下一个源。
- 只有成功解析出 torrent 元数据后才会保存，避免把 HTML 错误页下载成 `.torrent`。

## 3.1.0：按实际名称保存

- 点击按钮后先读取 `.torrent` 文件并解析 bencode 格式的 `info.name.utf-8` / `info.name`。
- 下载文件自动命名为种子记录的实际名称，例如 `My Movie!.torrent`，不再默认使用 hash。
- 自动替换 Windows 文件名中的非法字符，并处理设备保留名和超长名称。
- 获取或解析元数据失败时，会回退到原来的 hash 文件名下载，不影响基本可用性。
- 下载期间按钮会显示读取、成功或失败状态，避免连续重复点击。

## 3.0.0 优化内容

- 删除原脚本中意外重复的整段代码，避免同时运行两个 observer。
- MutationObserver 仅扫描新增或发生变化的 DOM 子树，不再反复遍历整个页面。
- 将高频变更的 debounce（防抖）延迟降到 180ms，兼顾响应速度与性能。
- 分离“已处理元素”和“脚本生成元素”的标记，避免误判及重复按钮。
- 正确把 32 位 Base32 BTIH 转换成 iTorrents 所需的 40 位十六进制 hash。
- 支持同一代码块中的多个不同磁力链接。
- 纯文本磁力链接会变成真正可点击的 `magnet:` 链接，而不只是普通文本。
- 用一份 CSS 代替每个按钮的 inline 事件处理器，降低节点开销。
- 下载链接加入 `noopener`、`noreferrer` 和 `no-referrer`，减少来源信息泄露。
- 自动更新地址固定到本仓库 `main` 分支的 raw 文件。

## 支持范围

- `<a href="magnet:…">` 链接
- 页面普通文本中的磁力链接
- `<pre>`、`<code>` 和 Discuz `div.blockcode` 代码块
- 40 位十六进制 BTIH
- 32 位 Base32 BTIH
- SPA / 无限滚动等动态加载页面

## 隐私与限制

脚本使用 `@match *://*/*`，因为它需要在任意网页识别磁力链接。点击 **📥 种子** 后，脚本通过 `GM_xmlhttpRequest` 依次从 iTorrents 和 Torrage 获取 torrent 内容，在浏览器本地解析名称并保存；不会上传页面内容或 torrent 内容。能否成功下载取决于至少一个缓存源是否收录了该 hash。

## 本地验证

```bash
npm install
npm run check
```

测试覆盖 Base32 转换、bencode 名称解析、Windows 安全文件名、实际名称下载、重复扫描、普通文本、代码块、排除元素和动态 DOM。

## License

[MIT](LICENSE)
