# 磁力链接转种子下载

一个轻量的 Tampermonkey / Violentmonkey 用户脚本。它会识别网页中的 `magnet:` 链接，并在旁边添加 **📥 种子** 按钮，优先从公共缓存获取 `.torrent`；缓存均失败时，可调用 qBittorrent WebUI 从 DHT / Tracker / Peer 获取磁力元数据并导出 `.torrent`。

## 安装

[点击安装 userscript](https://raw.githubusercontent.com/Kesuy/magnet-to-torrent-userscript/main/magnet-to-torrent.user.js)

需要先安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。

已安装旧版本时，userscript 管理器会根据脚本中的 `@updateURL` 自动检查更新。

## 4.0.1：qBittorrent 用户名 / 密码登录

- qBittorrent 回退改为使用 WebUI **用户名 + 密码** 登录，不再使用 API Key。
- 脚本通过 `/api/v2/auth/login` 建立 WebUI Session，后续复用 Session Cookie 调用元数据接口。
- qB Session 失效或被拒绝时，会自动重新登录一次后重试。
- README 恢复直接安装链接和完整使用说明。

## 4.0.0：qBittorrent 元数据解析

- 删除 aria2 RPC 配置、连接测试及相关代码。
- 下载流程升级为：**公共 torrent 缓存 → qBittorrent metadata resolver**。
- 公共缓存依次尝试：iTorrents、Torrage、iTorrents.org、BTCache。
- 缓存全部失败且已启用 qBittorrent 回退时，调用 `fetchMetadata` 获取元数据，再通过 `saveMetadata` 导出真正的 `.torrent`。
- qBittorrent 只用于获取 metadata，不会把磁力链接加入下载任务。
- 保留完整 magnet URI，包括 `tr=` tracker 参数，交给 qBittorrent 参与元数据发现。
- 所有来源返回的 torrent 都会重新计算 `info` 字典 SHA-1，并确认与磁力 BTIH 一致。

## qBittorrent 配置

打开 Tampermonkey / Violentmonkey 的脚本菜单，选择：

- **⚙️ qBittorrent 设置**
- **🔌 测试 qBittorrent 登录**

需要填写：

1. **WebUI 地址**：例如 `http://127.0.0.1:8080`
2. **用户名**：默认通常为 `admin`，以你自己的 qBittorrent WebUI 配置为准
3. **密码**：qBittorrent WebUI 登录密码
4. **等待元数据时间**：默认 60 秒，可设置 10～300 秒
5. 勾选 **启用 qBittorrent 回退**

建议先点击 **测试登录**。成功后会显示当前 qBittorrent 版本号。

> 用户名和密码保存在 userscript 管理器提供的脚本专属存储中，不会写入网页 URL。若 WebUI 暴露在局域网或公网，建议使用 HTTPS 或仅允许可信网络访问。

## 下载流程

点击 **📥 种子** 后：

1. 依次查询公共 torrent 缓存。
2. 每个返回文件都会先解析 bencode，并校验 BTIH。
3. 如果缓存均失败且未启用 qBittorrent，则直接提示失败。
4. 如果已启用 qBittorrent，则先登录 WebUI。
5. 调用 `torrents/fetchMetadata`，由 qBittorrent 使用 DHT / Tracker / Peer 查找 metadata。
6. metadata 可用后调用 `torrents/saveMetadata` 导出 torrent。
7. 再次校验 infohash，最后按 torrent 内的实际名称保存文件。

如果缓存不存在，而且 DHT / Tracker / Peer 中也没有任何节点能够提供 metadata，那么 qBittorrent 同样无法恢复完整 torrent。这属于磁力本身已经“死种/无元数据来源”，不是脚本故障。

## 支持范围

- `<a href="magnet:…">` 链接
- 页面普通文本中的磁力链接
- `<pre>`、`<code>` 和 Discuz `div.blockcode` 代码块
- 40 位十六进制 BTIH
- 32 位 Base32 BTIH
- SPA / 无限滚动等动态加载页面
- 完整 magnet URI，包括名称和 tracker 参数

## 文件安全校验

脚本不会直接相信缓存服务器或 qBittorrent 返回的文件：

- 解析 torrent 的原始 bencode `info` 字典
- 重新计算 SHA-1
- 与磁力链接中的 BTIH 比较
- 不一致则拒绝下载

因此缓存源返回错误文件、HTML 错误页或无关 torrent 时，不会被当成正确种子保存。

## 隐私与权限

脚本使用 `@match *://*/*`，因为需要在任意网页识别磁力链接。

`@connect *` 用于支持用户自行填写不同地址的 qBittorrent WebUI。脚本不会把当前网页正文上传给 qBittorrent；qB 回退只发送对应的 magnet URI，并使用你配置的 WebUI 登录信息建立会话。

## 本地验证

```bash
npm install
npm run check
```

测试覆盖：qBittorrent 用户名/密码登录、元数据导出、公共缓存回退、Base32 BTIH 转换、bencode 名称解析、infohash 校验、Windows 安全文件名、完整 magnet 保留、重复扫描和动态 DOM。

## License

[MIT](LICENSE)
