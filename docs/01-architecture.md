# 照片仓库 · 架构与数据模型（阶段 1）

版本：1.0.0

## 1. 总览

```
┌───────────────────────────── Electron 主进程 ─────────────────────────────┐
│  main.js                                                                 │
│   ├─ Config（userData/config.json：存储根、libraryId、窗口、UI）           │
│   ├─ Library（索引、导入、CRUD、分类、裁剪、回收站、迁移、缓存编排）         │
│   ├─ MediaServer（127.0.0.1 随机端口 + 会话 token，支持 Range）            │
│   └─ IPC 注册（统一 { ok, data } / { ok:false, error, code }）             │
│        │ contextBridge（preload.js，白名单暴露）                          │
└────────┼─────────────────────────────────────────────────────────────────┘
         │
┌────────▼──────────────────── 渲染进程（sandbox） ─────────────────────────┐
│  src/index.html + styles.css + app.js                                    │
│   ├─ 虚拟滚动网格、时间线分组、相册/标签/收藏/搜索/回收站                  │
│   ├─ 悬停实况播放、查看器、裁剪弹窗、设置/迁移、导入进度                   │
│   └─ 仅通过 window.api 调用主进程；图片/视频经本地 HTTP 服务加载           │
└──────────────────────────────────────────────────────────────────────────┘
```

选择本地 HTTP 流服务的理由：渲染进程开启 `sandbox`、`contextIsolation`、关闭 `nodeIntegration`，`file://` 直连受限；HTTP 服务可同时满足缩略图、全尺寸、裁剪源、实况/视频 Range 播放，并通过随机端口 + token 防止其它本机进程随意读取。

## 2. 目录规范（`{{storage_root}}`）

```
{{storage_root}}/
├─ Photos/YYYY/YYYY-MM/      静态原图（原样复制，永不改写）
├─ Videos/YYYY/YYYY-MM/      独立视频原件
├─ Live/YYYY/YYYY-MM/        实况关联视频（配对复制 / 内嵌无流转存）
├─ Derived/Crops/            裁剪导出副本（PNG 无损，导出时生成）
├─ Trash/<itemId>/           回收站（软删除文件，可还原）
└─ .photo-repo/
   ├─ library.json           可重建索引
   └─ cache/
      ├─ thumbs/             网格缩略图（显示层）
      ├─ covers/             视频封面（显示层）
      ├─ full/               非 JPEG 的全尺寸 PNG 视图（显示层）
      └─ proxies/            兼容播放版本：*-play.mp4 / *-proxy.mp4
```

`library.json` 记录 `libraryId`，用于介质断连后跨盘符定位库；除该文件与回收站外，库内所有媒体文件均为原件或可重建派生件。

## 3. 数据模型

### 3.1 library.json

```json
{
  "version": 1,
  "libraryId": "<uuid>",
  "name": "照片仓库",
  "createdAt": 0,
  "updatedAt": 0,
  "items": [],
  "albums": [{ "id": "<uuid>", "name": "旅行", "createdAt": 0 }]
}
```

### 3.2 item 字段

| 字段 | 说明 |
| --- | --- |
| `id` | 条目 UUID |
| `type` | `image` / `video` / `live` |
| `name` / `ext` | 原文件名与扩展名 |
| `stillRel` | 静态原件相对路径（照片/实况） |
| `videoRel` | 视频原件相对路径（独立视频） |
| `motionRel` / `motionKind` / `motionStatus` | 实况关联件路径 / 来源（`paired`/`google`/`samsung`）/ 状态（`ready`/`unsupported`） |
| `motionCodec` / `motionDuration` | 实况视频编码与时长 |
| `size` / `hash` | 字节数与 SHA-256（去重与校验依据） |
| `width` / `height` / `duration` | 像素尺寸与视频时长 |
| `takenAt` / `importedAt` / `updatedAt` | 拍摄时间、导入时间、更新时间 |
| `make` / `model` / `gps` | EXIF 设备与位置信息 |
| `favorite` | 收藏 |
| `tags` | 标签数组 |
| `albumIds` | 所属相册 ID 数组 |
| `crop` | 归一化裁剪矩形 `{x,y,w,h}`（0~1），空表示未裁剪 |
| `deletedAt` | 软删除时间；存在即位于回收站 |
| `prevStillRel` / `prevVideoRel` / `prevMotionRel` | 删除前路径，用于原样还原 |
| `displaySupported` | 是否可直接显示（RAW 等为 false） |
| `videoCodec` | 视频编码（用于判断浏览器兼容性） |

### 3.3 索引写入

更新先入内存，`scheduleSave()` 合并短时间内的多次写入，`flush()` 在退出前落盘；写入采用临时文件 + rename 的原子替换，避免半写坏档。

### 3.4 导入并发

- 图片与未配对视频组成独立任务，由固定并发池（默认 4 路）并行处理；iPhone 配对视频随主图一起导入。
- 复制使用 `fs.copyFile`（系统级复制），随后只对目标文件计算一次 SHA-256，兼顾速度与去重。
- 并发下通过「哈希占用集合」与「目标文件名预留队列」保证同内容只入库一次、同名文件不互相覆盖。
- 每完成一个条目即向渲染进程推送 `import-progress`（含公共条目数据），网格实时并入新照片；导入结束后再推送一次完整状态校正。

## 4. 像素保真链路

```
源文件 ──fs.copyFile──▶ 临时 .part ──SHA-256──▶ 校验 ──rename──▶ 目标原件
```

- `copyVerified(src, dst, expectedHash?)`：系统级复制后对目标文件计算 SHA-256；传入期望哈希时比对，失败即删除临时文件，源文件不动。
- 导入时以目标哈希作为条目 `hash` 并用于去重：同内容只入库一次；实况配对视频随主图一起入库。
- 缩略图、封面、全尺寸 PNG、兼容预览全部写入 `.photo-repo/cache`，永不回写原件。
- 导入、迁移、导出裁剪副本均复用 `copyVerified`；迁移时额外传入源文件哈希做逐文件一致性校验。

## 5. 实况识别与抽取

| 来源 | 识别方式 | 抽取 |
| --- | --- | --- |
| iPhone | 同目录、同主文件名（大小写不敏感）的图片 + 视频 | 直接复制视频为 `Live/.../<stem>.<ext>` |
| Google Motion Photo | XMP `MicroVideoOffset`（属性写法与元素写法均支持） | 按长度从文件尾部切出 MP4 |
| Samsung 变体 | 尾部查找合法 `ftyp` 品牌（mp42/mp41/isom/qt/avc1 等） | 从 `ftyp` 起切出 MP4 |

- 切出的动态段先由 ffmpeg 探测；若直接探测失败，做一次无损 remux（`-c copy`）清洗后重试。
- 仍失败则保留静态图，`motionStatus = unsupported`，界面显示「实况 · 待支持」。
- 抽取目标文件使用 `uniqueFile` 避免同名覆盖；失败时删除候选文件。

## 6. 显示与播放

- **JPEG**：查看器直接使用原件；裁剪时另行生成/缓存全尺寸 PNG。
- **PNG / WebP / GIF / BMP / AVIF**：浏览器可直接显示；查看器全尺寸显示按需生成 PNG（`cache/full`）。
- **HEIC / HEIF**：`heic-decode`（libheif WASM）解码后生成缩略图/全尺寸 PNG，不依赖 Windows HEIF 扩展。
- **RAW**：入库保存，`displaySupported=false`，界面标记「格式待支持」。
- **视频**：
  - 浏览器原生支持的编码（H.264 / VP8 / VP9 / AV1）→ 无损 remux 为 `*-play.mp4`（faststart）。
  - HEVC 等不支持的编码 → 生成 `*-proxy.mp4`（H.264，长边 ≤1280，CRF 23），仅用于显示；原件不变。
- **悬停播放**：指针进入瓦片 120 ms 后启动静音循环播放；移出停止并释放；失败时回退为静态并标记。

## 7. 存储根与可移动介质

- 首次启动无配置时进入引导页，由用户选择目录；配置保存 `storageRoot` 与 `libraryId`。
- 每 3 秒轮询库根可用性：
  - 不可用 → 只读降级，界面横幅提示，所有写操作被拒绝，不崩溃。
  - 恢复 → 自动恢复写权限并刷新状态。
- 重连后若盘符变化：按 `libraryId` 扫描已挂载盘符及其一级目录下的 `.photo-repo/library.json` 定位库。
- 迁移：逐文件复制 + 校验到新根，成功后切换配置并重建服务；失败清理目标副本，原库保持可用。

## 8. 接口清单

### 8.1 IPC（渲染 → 主进程）

| 通道 | 作用 |
| --- | --- |
| `app:state` | 获取应用与库状态 |
| `app:pick-root` / `app:use-root` / `app:locate-root` | 选择、使用、按 libraryId 定位存储根 |
| `app:open-root` / `app:reveal-item` / `app:open-external` | 打开库目录、定位文件、打开外部链接 |
| `app:set-ui` | 保存瓦片尺寸等 UI 偏好 |
| `library:import-dialog` / `library:import-paths` | 选择文件/文件夹并导入 |
| `library:rescan` | 重建索引（合并分类与裁剪信息） |
| `library:update-item` | 更新收藏、标签等 |
| `library:delete-items` / `restore-items` / `purge-items` / `empty-trash` | 回收站操作 |
| `library:create-album` / `rename-album` / `delete-album` / `add-to-album` / `remove-from-album` | 相册管理 |
| `library:save-crop` / `export-crop` | 保存裁剪矩形 / 导出 PNG 无损副本 |
| `library:verify-item` | 重算原件 SHA-256 并与索引比对 |
| `library:clear-cache` | 清理显示层缓存 |
| `library:migrate` / `library:stats` | 迁移存储根 / 统计信息 |

### 8.2 事件（主进程 → 渲染）

`import-progress`、`rescan-progress`、`migrate-progress`、`library-changed`、`storage-state`。

### 8.3 本地媒体 HTTP

```
GET http://127.0.0.1:<port>/m/<token>/<kind>/<id>?s=<size>&v=<version>&crop=<0|1>
kind: thumb | full | source | live | video
```

- 仅监听 `127.0.0.1`；token 每次启动随机生成。
- 支持 `Range`（206），便于视频拖动；并发请求按 `kind+id+参数` 合并，避免重复生成。

## 9. 关键设计取舍

1. **原件不可变 + 派生件可重建**：所有编辑都以元数据或派生件表达，索引与缓存损坏不影响原件。
2. **索引与分类分离**：重建索引扫描文件系统，按 `hash` 合并已有条目的收藏、标签、相册、裁剪信息。
3. **显示层与保真层分离**：缩略图/兼容预览只服务于屏幕，不参与导出与校验。
4. **本地 HTTP 而非自定义协议**：同时满足 Range、CSP 白名单与沙箱渲染进程的安全边界。
