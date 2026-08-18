# 磁力链接转种子下载

一个 Tampermonkey / Violentmonkey 用户脚本。

## 4.0.0：qBittorrent 元数据解析

- 删除 aria2 RPC 配置与测试逻辑。
- 下载流程升级为多级解析：公共 torrent 缓存 → qBittorrent metadata resolver。
- 新增 BTCache 回退源。
- 保留 infohash 校验，拒绝错误 torrent。
- 保留完整 magnet URI，qBittorrent 可以利用 tracker 信息。

## qBittorrent 配置

脚本菜单：

`⚙️ qBittorrent 设置`

填写：

- WebUI 地址，例如 `http://127.0.0.1:8080`
- WebUI API Key（推荐）
- 元数据等待时间

流程：

1. 脚本先查询公共缓存。
2. 缓存失败后调用 qBittorrent `fetchMetadata`。
3. 获取 metadata 后调用 `saveMetadata` 导出 torrent。
4. 本地校验 BTIH 后保存。

注意：qBittorrent 只负责获取 metadata，不会把磁力加入下载任务。

## 限制

如果缓存不存在，且 DHT / Tracker 中没有可提供 metadata 的 Peer，任何客户端都无法恢复完整 torrent。

## 本地验证

```bash
npm install
npm run check
```

## License

MIT
