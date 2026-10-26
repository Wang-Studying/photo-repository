'use strict';

/**
 * 媒体库核心：目录规范、索引、导入（字节级校验）、CRUD、分类、裁剪元数据、
 * 回收站、检索辅助、索引重建、库迁移。
 *
 * 目录规范（{{storage_root}} 由用户自选，可指向 U 盘）：
 *   Photos/YYYY/YYYY-MM/*            静态原图（原样复制，永不改写）
 *   Videos/YYYY/YYYY-MM/*            独立视频原件
 *   Live/YYYY/YYYY-MM/*              实况关联视频（配对复制或内嵌无流转存）
 *   Derived/Crops/                   裁剪派生件（导出时生成，PNG 无损）
 *   Trash/<itemId>/                  回收站（软删除，可还原）
 *   .photo-repo/library.json         可重建索引
 *   .photo-repo/cache/               缩略图/兼容预览（可随时清理重建）
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const {
  IMAGE_EXT, RAW_EXT, VIDEO_EXT, BROWSER_IMAGE_EXT, extOf, toNative, toPosix,
  ensureDir, exists, sha256File, copyVerified, atomicWriteJson, readJson, uniqueFile,
  probeVideo, clamp01, round4, stemOf,
} = require('./util');
const media = require('./media');
const motion = require('./motion');

const DIRS = {
  originals: 'Photos',
  videos: 'Videos',
  live: 'Live',
  derived: 'Derived/Crops',
  trash: 'Trash',
  meta: '.photo-repo',
  cache: '.photo-repo/cache',
};

const MAX_IMPORT_FILES = 20000;
// 导入并发度：独立文件互不依赖，适当并发可显著缩短总耗时
const IMPORT_CONCURRENCY = 4;

/** 简易并发池：按固定并发度执行任务，保持单个失败不影响其它任务；shouldStop 在取下一个任务前检查，已开始的任务照常完成 */
async function runPool(items, limit, worker, shouldStop) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      if (shouldStop && shouldStop()) break;
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function now() { return Date.now(); }
function dateParts(ts) {
  const d = new Date(ts || Date.now());
  const y = String(d.getFullYear());
  const m = `${y}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return { y, m };
}

async function walk(dir, acc = [], depth = 0) {
  if (depth > 12) return acc;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '.photo-repo') continue;
      await walk(abs, acc, depth + 1);
    } else if (ent.isFile()) {
      acc.push(abs);
    }
  }
  return acc;
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

class Library {
  constructor(root) {
    this.root = path.resolve(root);
    this.index = null;
    this._saveTimer = null;
    this._savePending = null;
    this._idMap = new Map();
    this._hashMap = new Map();
    this._relMap = new Map();
    this._pendingHashes = new Set();
    this._reserved = new Set();
    this._reserveQueue = Promise.resolve();
  }

  /** 在同目录下预留一个不冲突的文件名（并发导入时避免同名撞车） */
  reserveDest(dir, name) {
    const run = async () => {
      const ext = path.extname(name);
      const stem = path.basename(name, ext);
      let candidate = path.join(dir, name);
      let i = 1;
      while (await exists(candidate) || this._reserved.has(candidate.toLowerCase())) {
        candidate = path.join(dir, `${stem}-${i}${ext}`);
        i += 1;
      }
      this._reserved.add(candidate.toLowerCase());
      return candidate;
    };
    const p = this._reserveQueue.then(run, run);
    this._reserveQueue = p.catch(() => {});
    return p;
  }

  // ---------- 基础路径 ----------
  abs(rel) { return path.join(this.root, toNative(rel)); }
  rel(abs) { return toPosix(path.relative(this.root, abs)); }
  get indexPath() { return path.join(this.root, toNative(DIRS.meta), 'library.json'); }
  get cacheDir() { return path.join(this.root, toNative(DIRS.cache)); }
  get thumbDir() { return path.join(this.cacheDir, 'thumbs'); }
  get fullDir() { return path.join(this.cacheDir, 'full'); }
  get proxyDir() { return path.join(this.cacheDir, 'proxies'); }
  get coverDir() { return path.join(this.cacheDir, 'covers'); }

  // ---------- 打开 / 建库 ----------
  async open() {
    await this.ensureLayout();
    const raw = await readJson(this.indexPath, null);
    if (raw && Array.isArray(raw.items)) {
      this.index = {
        version: 1,
        libraryId: raw.libraryId || crypto.randomUUID(),
        name: raw.name || '照片仓库',
        createdAt: raw.createdAt || now(),
        updatedAt: raw.updatedAt || now(),
        items: raw.items,
        albums: Array.isArray(raw.albums) ? raw.albums : [],
      };
    } else {
      this.index = {
        version: 1, libraryId: crypto.randomUUID(), name: '照片仓库',
        createdAt: now(), updatedAt: now(), items: [], albums: [],
      };
      await this.flush();
    }
    this.reindexMaps();
    return this;
  }

  async ensureLayout() {
    await ensureDir(this.root);
    for (const rel of [DIRS.originals, DIRS.videos, DIRS.live, DIRS.derived, DIRS.trash, DIRS.meta]) {
      await ensureDir(path.join(this.root, toNative(rel)));
    }
    for (const dir of [this.thumbDir, this.fullDir, this.proxyDir, this.coverDir]) {
      await ensureDir(dir);
    }
    await ensureDir(path.join(this.root, '.photo-repo', 'logs'));
  }

  reindexMaps() {
    this._idMap.clear();
    this._hashMap.clear();
    this._relMap.clear();
    for (const item of this.index.items) {
      this._idMap.set(item.id, item);
      if (item.hash) this._hashMap.set(item.hash, item);
      if (item.stillRel) this._relMap.set(item.stillRel.toLowerCase(), item);
      if (item.videoRel) this._relMap.set(item.videoRel.toLowerCase(), item);
    }
  }

  // ---------- 持久化 ----------
  scheduleSave() {
    this.index.updatedAt = now();
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this.flush().catch(() => {}); }, 300);
  }

  async flush() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    await atomicWriteJson(this.indexPath, this.index);
  }

  get isAvailable() {
    try { return fs.existsSync(this.root); } catch { return false; }
  }

  assertAvailable() {
    if (!this.isAvailable) {
      const err = new Error('存储介质不可用（可能已断开），当前为只读状态');
      err.code = 'STORAGE_UNAVAILABLE';
      throw err;
    }
  }

  // ---------- 查询 / 对外状态 ----------
  get items() { return this.index.items; }
  get albums() { return this.index.albums; }

  findById(id) { return this._idMap.get(id) || null; }

  publicItem(item) {
    return {
      id: item.id,
      type: item.type,
      name: item.name,
      ext: item.ext,
      width: item.width,
      height: item.height,
      duration: item.duration || 0,
      size: item.size,
      hash: item.hash,
      takenAt: item.takenAt,
      importedAt: item.importedAt,
      updatedAt: item.updatedAt,
      make: item.make || '',
      model: item.model || '',
      favorite: Boolean(item.favorite),
      tags: item.tags || [],
      albumIds: item.albumIds || [],
      crop: item.crop || null,
      deletedAt: item.deletedAt || null,
      motionStatus: item.motionStatus || null,
      motionKind: item.motionKind || null,
      motionCodec: item.motionCodec || null,
      displaySupported: item.displaySupported !== false,
      videoCodec: item.videoCodec || null,
      gps: item.gps || null,
    };
  }

  tagList() {
    const map = new Map();
    for (const item of this.index.items) {
      if (item.deletedAt) continue;
      for (const t of item.tags || []) map.set(t, (map.get(t) || 0) + 1);
    }
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  publicState() {
    const items = this.index.items;
    const live = items.filter((i) => i.type === 'live' && !i.deletedAt);
    return {
      root: this.root,
      libraryId: this.index.libraryId,
      name: this.index.name,
      createdAt: this.index.createdAt,
      albums: this.index.albums,
      tags: this.tagList(),
      items: items.map((i) => this.publicItem(i)),
      stats: {
        total: items.filter((i) => !i.deletedAt).length,
        photos: items.filter((i) => !i.deletedAt && i.type === 'image').length,
        videos: items.filter((i) => !i.deletedAt && i.type === 'video').length,
        live: live.length,
        liveUnsupported: live.filter((i) => i.motionStatus === 'unsupported').length,
        favorites: items.filter((i) => !i.deletedAt && i.favorite).length,
        trash: items.filter((i) => i.deletedAt).length,
        bytes: items.reduce((s, i) => s + (i.size || 0), 0),
      },
    };
  }

  // ---------- 导入 ----------
  async expandPaths(paths, options = {}) {
    // 手机导入的暂存目录允许位于库内（同卷，入库时直接改名，不再产生第二份数据）
    const stagingDir = options.stagingDir ? path.resolve(options.stagingDir) : null;
    const files = [];
    const seen = new Set();
    for (const p of paths || []) {
      const abs = path.resolve(p);
      const insideRoot = abs === this.root || isInside(this.root, abs);
      const isStaging = Boolean(stagingDir && (abs === stagingDir || isInside(stagingDir, abs)));
      if (insideRoot && !isStaging) continue;
      let st;
      try { st = await fsp.stat(abs); } catch { continue; }
      if (st.isDirectory()) {
        const found = await walk(abs);
        for (const f of found) {
          const ext = extOf(f);
          if (IMAGE_EXT.has(ext) || RAW_EXT.has(ext) || VIDEO_EXT.has(ext)) {
            const key = f.toLowerCase();
            if (!seen.has(key)) { seen.add(key); files.push(f); }
          }
        }
      } else if (st.isFile()) {
        const ext = extOf(abs);
        if (IMAGE_EXT.has(ext) || RAW_EXT.has(ext) || VIDEO_EXT.has(ext)) {
          const key = abs.toLowerCase();
          if (!seen.has(key)) { seen.add(key); files.push(abs); }
        }
      }
      if (files.length > MAX_IMPORT_FILES) break;
    }
    return files.slice(0, MAX_IMPORT_FILES);
  }

  /**
   * 源文件是否已位于本库所在卷（例如手机导入的库内暂存目录）。
   * 这种情况入库可以原地改名，不需要再写第二份数据。
   */
  isStagedSrc(src) {
    const abs = path.resolve(src);
    return abs === this.root || isInside(this.root, abs);
  }

  /**
   * 入库写盘：源在本库内（同卷）时直接改名到目标位置，只读一遍源算 SHA-256 做无损校验，
   * 全程不产生第二份数据；跨卷时回退为流式复制+哈希校验。
   * 返回 { hash, size, adopted }。
   */
  async adoptVerified(src, dst) {
    if (!this.isStagedSrc(src)) {
      const copied = await copyVerified(src, dst);
      return { ...copied, adopted: false };
    }
    const hash = await sha256File(src);
    const st = await fsp.stat(src);
    try {
      await fsp.rename(src, dst);
      return { hash, size: st.size, adopted: true };
    } catch (e) {
      // 少数同卷但被占用/权限受限的情况，退回复制并删除暂存件
      if (e && ['EXDEV', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
        const copied = await copyVerified(src, dst);
        await fsp.unlink(src).catch(() => {});
        return { ...copied, adopted: false };
      }
      throw e;
    }
  }

  newItem(patch) {
    const ts = now();
    return {
      id: crypto.randomUUID(),
      type: 'image',
      name: '',
      ext: '',
      stillRel: null,
      videoRel: null,
      motionRel: null,
      motionKind: null,
      motionStatus: null,
      motionCodec: null,
      motionDuration: 0,
      size: 0,
      hash: '',
      width: 0,
      height: 0,
      duration: 0,
      takenAt: ts,
      importedAt: ts,
      updatedAt: ts,
      make: '',
      model: '',
      lens: '',
      exposure: null,
      gps: null,
      favorite: false,
      tags: [],
      albumIds: [],
      crop: null,
      deletedAt: null,
      prevStillRel: null,
      prevVideoRel: null,
      prevMotionRel: null,
      displaySupported: true,
      videoCodec: null,
      ...patch,
    };
  }

  async importPaths(paths, onProgress = () => {}, options = {}) {
    this.assertAvailable();
    const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : null;
    const files = await this.expandPaths(paths, options);
    if (!files.length) {
      return { added: 0, skipped: 0, failed: [], live: 0, total: 0, processed: 0, cancelled: false };
    }

    const imageFiles = [];
    const videoFiles = [];
    for (const f of files) {
      const ext = extOf(f);
      if (VIDEO_EXT.has(ext)) videoFiles.push(f);
      else imageFiles.push(f);
    }

    // iPhone 实况配对：同目录 + 同主名
    const videoByKey = new Map();
    for (const v of videoFiles) videoByKey.set(motion.pairKey(v), v);
    const pairedVideos = new Set();
    const pairs = new Map();
    for (const img of imageFiles) {
      const v = videoByKey.get(motion.pairKey(img));
      if (v) { pairs.set(img, v); pairedVideos.add(v); }
    }

    // 任务只包含图片与未配对视频；配对视频随主图一起导入
    const tasks = [];
    for (const img of imageFiles) {
      tasks.push({ file: img, partner: pairs.get(img) || null, video: false });
    }
    for (const vid of videoFiles) {
      if (!pairedVideos.has(vid)) tasks.push({ file: vid, partner: null, video: true });
    }

    const total = tasks.length;
    let done = 0;
    const summary = { added: 0, skipped: 0, failed: [], live: 0, total, processed: 0, cancelled: false };
    const bump = (current, item = null) => {
      done += 1;
      onProgress({
        phase: '复制', done, total,
        added: summary.added, skipped: summary.skipped,
        current, item: item ? this.publicItem(item) : null,
      });
    };

    const logLines = [];

    await runPool(tasks, IMPORT_CONCURRENCY, async (task) => {
      try {
        const { status, item } = task.video
          ? await this.importVideo(task.file)
          : await this.importStill(task.file, task.partner);
        if (status === 'added' || status === 'live' || status === 'live-unsupported') {
          summary.added += 1;
          if (status !== 'added') summary.live += 1;
          if (status === 'live-unsupported') logLines.push(`实况待支持: ${task.file}`);
        } else {
          summary.skipped += 1;
          logLines.push(`跳过重复: ${task.file}`);
        }
        bump(task.file, item);
      } catch (e) {
        summary.failed.push({ file: task.file, reason: e.message });
        logLines.push(`失败: ${task.file} :: ${e.message}`);
        bump(task.file);
      }
    }, shouldStop);

    // 取消时：已开始的任务全部完成，未开始的任务不再执行
    summary.processed = done;
    summary.cancelled = Boolean(shouldStop && shouldStop());
    if (summary.cancelled) logLines.push(`用户取消：已处理 ${done}/${total} 条，其余未导入`);

    await this.flush();
    if (logLines.length) {
      const logFile = path.join(this.root, '.photo-repo', 'logs', 'import.log');
      try {
        await fsp.appendFile(logFile, `\n[${new Date().toISOString()}]\n${logLines.join('\n')}\n`, 'utf8');
      } catch {}
    }
    return summary;
  }

  async importStill(src, pairedVideo) {
    const ext = extOf(src);
    const isRaw = RAW_EXT.has(ext);
    const meta = await media.readMeta(src);
    const takenAt = meta.takenAt || now();
    const { y, m } = dateParts(takenAt);
    const destDir = path.join(this.root, toNative(DIRS.originals), y, m);
    await ensureDir(destDir);
    const dest = await this.reserveDest(destDir, path.basename(src));
    const copied = await this.adoptVerified(src, dest);

    if (this._hashMap.has(copied.hash) || this._pendingHashes.has(copied.hash)) {
      await fsp.unlink(dest).catch(() => {});
      return { status: 'skipped', item: null };
    }
    this._pendingHashes.add(copied.hash);

    try {
      const item = this.newItem({
        type: 'image',
        name: path.basename(dest),
        ext,
        stillRel: this.rel(dest),
        size: copied.size,
        hash: copied.hash,
        width: meta.width || 0,
        height: meta.height || 0,
        takenAt,
        make: meta.make,
        model: meta.model,
        lens: meta.lens || '',
        exposure: meta.exposure || null,
        gps: meta.gps,
        displaySupported: !isRaw,
      });

      this.index.items.push(item);
      this._idMap.set(item.id, item);
      this._hashMap.set(item.hash, item);
      this._relMap.set(item.stillRel.toLowerCase(), item);
      this.scheduleSave();

      let liveUnsupported = false;

      if (pairedVideo) {
        try {
          const vExt = extOf(pairedVideo);
          const liveDir = path.join(this.root, toNative(DIRS.live), y, m);
          await ensureDir(liveDir);
          const stem = stemOf(item.name);
          const videoDest = await this.reserveDest(liveDir, `${stem}${vExt}`);
          await this.adoptVerified(pairedVideo, videoDest);
          const probe = await probeVideo(videoDest);
          item.type = 'live';
          item.motionRel = this.rel(videoDest);
          item.motionKind = 'paired';
          item.motionStatus = probe.ok ? 'ready' : 'unsupported';
          item.motionCodec = probe.codec || null;
          item.motionDuration = probe.duration || 0;
          item.updatedAt = now();
          this._relMap.set(item.motionRel.toLowerCase(), item);
          if (!probe.ok) liveUnsupported = true;
        } catch (e) {
          item.type = 'live';
          item.motionStatus = 'unsupported';
          item.updatedAt = now();
          liveUnsupported = true;
        }
      } else if (!isRaw && (ext === '.jpg' || ext === '.jpeg' || ext === '.heic' || ext === '.heif')) {
        // 单文件内嵌动态段（Google / Samsung）
        try {
          const liveDir = path.join(this.root, toNative(DIRS.live), y, m);
          await ensureDir(liveDir);
          const stem = stemOf(item.name);
          const candidate = await this.reserveDest(liveDir, `${stem}.mp4`);
          const extracted = await motion.extractEmbeddedMotion(dest, candidate);
          if (extracted.ok) {
            item.type = 'live';
            item.motionRel = this.rel(candidate);
            item.motionKind = extracted.kind;
            item.motionStatus = 'ready';
            item.motionCodec = extracted.codec;
            item.motionDuration = extracted.duration || 0;
            item.updatedAt = now();
            this._relMap.set(item.motionRel.toLowerCase(), item);
          } else if (extracted.detected) {
            // 已确认内嵌动态段但解码器不支持：按「实况（待支持）」归类，避免误判为静态图
            item.type = 'live';
            item.motionRel = this.rel(candidate);
            item.motionKind = extracted.kind;
            item.motionStatus = 'unsupported';
            item.updatedAt = now();
            this._relMap.set(item.motionRel.toLowerCase(), item);
            liveUnsupported = true;
          } else {
            await fsp.unlink(candidate).catch(() => {});
            this._reserved.delete(candidate.toLowerCase());
          }
        } catch { /* 无动态段属正常情况 */ }
      }

      this.scheduleSave();
      if (liveUnsupported) return { status: 'live-unsupported', item };
      return { status: item.type === 'live' ? 'live' : 'added', item };
    } finally {
      this._pendingHashes.delete(copied.hash);
    }
  }

  async importVideo(src) {
    const ext = extOf(src);
    const meta = await media.readVideoMeta(src);
    const takenAt = meta.takenAt || now();
    const { y, m } = dateParts(takenAt);
    const destDir = path.join(this.root, toNative(DIRS.videos), y, m);
    await ensureDir(destDir);
    const dest = await this.reserveDest(destDir, path.basename(src));
    const copied = await this.adoptVerified(src, dest);

    if (this._hashMap.has(copied.hash) || this._pendingHashes.has(copied.hash)) {
      await fsp.unlink(dest).catch(() => {});
      return { status: 'skipped', item: null };
    }
    this._pendingHashes.add(copied.hash);

    try {
      const item = this.newItem({
        type: 'video',
        name: path.basename(dest),
        ext,
        videoRel: this.rel(dest),
        size: copied.size,
        hash: copied.hash,
        width: meta.width || 0,
        height: meta.height || 0,
        duration: meta.duration || 0,
        takenAt,
        make: meta.make,
        model: meta.model,
        videoCodec: meta.codec || null,
      });

      this.index.items.push(item);
      this._idMap.set(item.id, item);
      this._hashMap.set(item.hash, item);
      this._relMap.set(item.videoRel.toLowerCase(), item);
      this.scheduleSave();
      return { status: 'added', item };
    } finally {
      this._pendingHashes.delete(copied.hash);
    }
  }

  // ---------- 索引重建 ----------
  async rescan(onProgress = () => {}) {
    this.assertAvailable();
    const originalFiles = await walk(path.join(this.root, toNative(DIRS.originals)));
    const stillFiles = originalFiles.filter((f) => IMAGE_EXT.has(extOf(f)) || RAW_EXT.has(extOf(f)));
    const sameDirLiveFiles = originalFiles.filter((f) => VIDEO_EXT.has(extOf(f)));
    const videoFiles = (await walk(path.join(this.root, toNative(DIRS.videos))))
      .filter((f) => VIDEO_EXT.has(extOf(f)));
    const liveFiles = (await walk(path.join(this.root, toNative(DIRS.live))))
      .filter((f) => VIDEO_EXT.has(extOf(f)));
    const trashFiles = await walk(path.join(this.root, toNative(DIRS.trash)));

    const prevItems = this.index.items.slice();
    const prevByRel = new Map();
    for (const it of prevItems) {
      if (it.stillRel) prevByRel.set(it.stillRel.toLowerCase(), it);
      if (it.videoRel) prevByRel.set(it.videoRel.toLowerCase(), it);
    }

    const liveByStem = new Map();
    for (const lf of liveFiles) {
      const stem = path.basename(lf, path.extname(lf)).toLowerCase();
      if (!liveByStem.has(stem)) liveByStem.set(stem, lf);
    }
    // 裁剪后另存的实况与原图同目录同名，优先按“目录 + 主名”配对
    const liveByPair = new Map();
    for (const lf of sameDirLiveFiles) liveByPair.set(motion.pairKey(lf), lf);

    const found = new Set();
    const next = [];
    const total = stillFiles.length + videoFiles.length;
    let done = 0;

    for (const abs of stillFiles) {
      const rel = this.rel(abs);
      const key = rel.toLowerCase();
      found.add(key);
      const prev = prevByRel.get(key);
      let item;
      if (prev) {
        item = prev;
      } else {
        const meta = await media.readMeta(abs);
        item = this.newItem({
          type: 'image',
          name: path.basename(abs),
          ext: extOf(abs),
          stillRel: rel,
          size: (await fsp.stat(abs)).size,
          hash: await sha256File(abs),
          width: meta.width || 0,
          height: meta.height || 0,
          takenAt: meta.takenAt || now(),
          make: meta.make,
          model: meta.model,
          gps: meta.gps,
          displaySupported: !RAW_EXT.has(extOf(abs)),
        });
      }
      const stem = path.basename(abs, path.extname(abs)).toLowerCase();
      const liveFile = liveByPair.get(motion.pairKey(abs)) || liveByStem.get(stem);
      if (liveFile) {
        const liveRel = this.rel(liveFile);
        const probe = await probeVideo(liveFile);
        item.type = 'live';
        item.motionRel = liveRel;
        item.motionKind = item.motionKind || 'paired';
        item.motionStatus = probe.ok ? 'ready' : 'unsupported';
        item.motionCodec = probe.codec || item.motionCodec || null;
        found.add(liveRel.toLowerCase());
      }
      next.push(item);
      done += 1;
      onProgress({ phase: '索引', done, total });
    }

    for (const abs of videoFiles) {
      const rel = this.rel(abs);
      const key = rel.toLowerCase();
      found.add(key);
      let item = prevByRel.get(key);
      if (!item) {
        const meta = await media.readVideoMeta(abs);
        item = this.newItem({
          type: 'video',
          name: path.basename(abs),
          ext: extOf(abs),
          videoRel: rel,
          size: (await fsp.stat(abs)).size,
          hash: await sha256File(abs),
          width: meta.width || 0,
          height: meta.height || 0,
          duration: meta.duration || 0,
          takenAt: meta.takenAt || now(),
          videoCodec: meta.codec || null,
        });
      }
      item.type = 'video';
      next.push(item);
      done += 1;
      onProgress({ phase: '索引', done, total });
    }

    // 回收站中的条目：仅保留文件仍存在的
    for (const it of prevItems) {
      if (!it.deletedAt) continue;
      const stillOk = it.stillRel && (await exists(this.abs(it.stillRel)));
      if (stillOk) next.push(it);
    }

    const prevIds = new Set(prevItems.map((i) => i.id));
    const added = next.filter((i) => !prevIds.has(i.id)).length;
    const removed = prevItems.filter((it) => !next.includes(it)).length;
    this.index.items = next;
    this.reindexMaps();
    await this.flush();
    onProgress({ phase: '完成', done: total, total });
    return {
      total: next.filter((i) => !i.deletedAt).length,
      added,
      removed,
    };
  }

  // ---------- 单条更新 ----------
  async updateItem(id, patch) {
    this.assertAvailable();
    const item = this.findById(id);
    if (!item) throw new Error('条目不存在');
    const changed = {};

    if (typeof patch.favorite === 'boolean') changed.favorite = patch.favorite;
    if (Array.isArray(patch.tags)) {
      const tags = [...new Set(patch.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 50);
      changed.tags = tags;
    }
    if (Array.isArray(patch.albumIds)) {
      const valid = new Set(this.index.albums.map((a) => a.id));
      changed.albumIds = [...new Set(patch.albumIds.filter((a) => valid.has(a)))];
    }
    if (patch.crop !== undefined) {
      changed.crop = this.normalizeCrop(patch.crop);
    }
    if (patch.takenAt && Number.isFinite(Number(patch.takenAt))) {
      // 仅允许调整时间（用于纠偏 EXIF 缺失），原文件不变
      changed.takenAt = Number(patch.takenAt);
    }

    Object.assign(item, changed, { updatedAt: now() });
    this.scheduleSave();
    return this.publicItem(item);
  }

  normalizeCrop(crop) {
    if (!crop) return null;
    const x = clamp01(Number(crop.x) || 0);
    const y = clamp01(Number(crop.y) || 0);
    const w = clamp01(Number(crop.w) || 1);
    const h = clamp01(Number(crop.h) || 1);
    if (w <= 0.01 || h <= 0.01) return null;
    const cropX = Math.min(x, 1 - 0.01);
    const cropY = Math.min(y, 1 - 0.01);
    if (cropX === 0 && cropY === 0 && w >= 0.999 && h >= 0.999) return null;
    return {
      x: round4(cropX), y: round4(cropY),
      w: round4(Math.min(w, 1 - cropX)), h: round4(Math.min(h, 1 - cropY)),
    };
  }

  // ---------- 相册 ----------
  async createAlbum(name) {
    this.assertAvailable();
    const clean = String(name || '').trim();
    if (!clean) throw new Error('相册名不能为空');
    if (this.index.albums.some((a) => a.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error('同名相册已存在');
    }
    const album = { id: crypto.randomUUID(), name: clean, createdAt: now() };
    this.index.albums.push(album);
    await this.flush();
    return album;
  }

  async renameAlbum(id, name) {
    this.assertAvailable();
    const album = this.index.albums.find((a) => a.id === id);
    if (!album) throw new Error('相册不存在');
    const clean = String(name || '').trim();
    if (!clean) throw new Error('相册名不能为空');
    album.name = clean;
    await this.flush();
    return album;
  }

  async deleteAlbum(id) {
    this.assertAvailable();
    this.index.albums = this.index.albums.filter((a) => a.id !== id);
    for (const item of this.index.items) {
      if (item.albumIds && item.albumIds.includes(id)) {
        item.albumIds = item.albumIds.filter((a) => a !== id);
        item.updatedAt = now();
      }
    }
    await this.flush();
    return true;
  }

  async addToAlbum(ids, albumId) {
    this.assertAvailable();
    if (!this.index.albums.some((a) => a.id === albumId)) throw new Error('相册不存在');
    for (const id of ids) {
      const item = this.findById(id);
      if (!item) continue;
      const set = new Set(item.albumIds || []);
      set.add(albumId);
      item.albumIds = [...set];
      item.updatedAt = now();
    }
    this.scheduleSave();
    return true;
  }

  async removeFromAlbum(ids, albumId) {
    this.assertAvailable();
    for (const id of ids) {
      const item = this.findById(id);
      if (!item) continue;
      item.albumIds = (item.albumIds || []).filter((a) => a !== albumId);
      item.updatedAt = now();
    }
    this.scheduleSave();
    return true;
  }

  // ---------- 删除 / 还原 / 彻底删除 ----------
  async moveFile(fromAbs, toAbs) {
    await ensureDir(path.dirname(toAbs));
    try {
      await fsp.rename(fromAbs, toAbs);
    } catch (e) {
      if (e.code === 'EXDEV') {
        await fsp.copyFile(fromAbs, toAbs);
        await fsp.unlink(fromAbs);
      } else {
        throw e;
      }
    }
  }

  async deleteItems(ids) {
    this.assertAvailable();
    const ts = now();
    let count = 0;
    for (const id of ids) {
      const item = this.findById(id);
      if (!item || item.deletedAt) continue;
      const trashDir = path.join(this.root, toNative(DIRS.trash), item.id);
      await ensureDir(trashDir);

      item.prevStillRel = item.stillRel;
      item.prevVideoRel = item.videoRel;
      item.prevMotionRel = item.motionRel;

      const primaryRel = item.stillRel || item.videoRel;
      if (primaryRel) {
        const primaryAbs = this.abs(primaryRel);
        if (await exists(primaryAbs)) {
          const dest = await uniqueFile(trashDir, path.basename(primaryAbs));
          await this.moveFile(primaryAbs, dest);
          const trashRel = this.rel(dest);
          if (item.stillRel) item.stillRel = trashRel;
          if (item.videoRel) item.videoRel = trashRel;
        }
      }
      if (item.motionRel) {
        const motionAbs = this.abs(item.motionRel);
        if (await exists(motionAbs)) {
          const dest = await uniqueFile(trashDir, path.basename(motionAbs));
          await this.moveFile(motionAbs, dest);
          item.motionRel = this.rel(dest);
        } else {
          item.motionRel = null;
        }
      }
      item.deletedAt = ts;
      item.updatedAt = ts;
      count += 1;
    }
    await this.flush();
    return { count };
  }

  async restoreItems(ids) {
    this.assertAvailable();
    let count = 0;
    const moveBack = async (currentRel, prevRel) => {
      if (!currentRel || !prevRel) return currentRel;
      const src = this.abs(currentRel);
      if (!(await exists(src))) return currentRel;
      const prevAbs = this.abs(prevRel);
      const dest = await uniqueFile(path.dirname(prevAbs), path.basename(prevAbs));
      await this.moveFile(src, dest);
      return this.rel(dest);
    };

    for (const id of ids) {
      const item = this.findById(id);
      if (!item || !item.deletedAt) continue;
      if (item.prevStillRel) item.stillRel = await moveBack(item.stillRel, item.prevStillRel);
      if (item.prevVideoRel) item.videoRel = await moveBack(item.videoRel, item.prevVideoRel);
      if (item.prevMotionRel) item.motionRel = await moveBack(item.motionRel, item.prevMotionRel);
      item.deletedAt = null;
      item.prevStillRel = null;
      item.prevVideoRel = null;
      item.prevMotionRel = null;
      item.updatedAt = now();
      count += 1;
    }
    this.reindexMaps();
    await this.flush();
    return { count };
  }

  async purgeItems(ids) {
    this.assertAvailable();
    let count = 0;
    for (const id of ids) {
      const item = this.findById(id);
      if (!item) continue;
      const trashDir = path.join(this.root, toNative(DIRS.trash), item.id);
      await fsp.rm(trashDir, { recursive: true, force: true }).catch(() => {});
      this.index.items = this.index.items.filter((i) => i.id !== id);
      count += 1;
    }
    this.reindexMaps();
    await this.flush();
    return { count };
  }

  async emptyTrash() {
    const ids = this.index.items.filter((i) => i.deletedAt).map((i) => i.id);
    return this.purgeItems(ids);
  }

  /** 新增条目并同步各类索引映射 */
  _registerItem(item) {
    this.index.items.push(item);
    this._idMap.set(item.id, item);
    if (item.hash) this._hashMap.set(item.hash, item);
    if (item.stillRel) this._relMap.set(item.stillRel.toLowerCase(), item);
    if (item.videoRel) this._relMap.set(item.videoRel.toLowerCase(), item);
    if (item.motionRel) this._relMap.set(item.motionRel.toLowerCase(), item);
  }

  /** 回滚尚未落定的新条目 */
  _unregisterItem(item) {
    if (!item) return;
    this.index.items = this.index.items.filter((it) => it !== item);
    this._idMap.delete(item.id);
    if (item.hash) this._hashMap.delete(item.hash);
    if (item.stillRel) this._relMap.delete(item.stillRel.toLowerCase());
    if (item.videoRel) this._relMap.delete(item.videoRel.toLowerCase());
    if (item.motionRel) this._relMap.delete(item.motionRel.toLowerCase());
  }

  // ---------- 裁剪 ----------
  /**
   * 保存裁剪（不覆盖原图）：
   * - 普通照片：在当前目录另存为一张新的裁剪图，原文件保持不变。
   * - 实况照片：在当前目录生成一张全新的裁剪实况（静止图 + 裁剪后的动态视频，二者同名），
   *   原图与原始动态视频保持不变。新文件为 H.264/AAC + faststart，可直接本机播放。
   */
  async saveCrop(id, crop) {
    this.assertAvailable();
    const item = this.findById(id);
    if (!item) throw new Error('条目不存在');
    if (item.type === 'video') throw new Error('视频不支持裁剪');
    const rect = this.normalizeCrop(crop);
    if (!rect) throw new Error('请先选择要保留的裁剪范围');

    if (item.type !== 'live') {
      const absFile = this.abs(item.stillRel);
      if (!(await exists(absFile))) throw new Error('原文件不可用');
      const meta = await media.readMeta(absFile);
      if (!meta.width || !meta.height) throw new Error('无法读取原图尺寸');

      // 保持原格式；HEIC/RAW 等无法直接回写的格式由 cropImageToFile 输出 PNG
      const srcExt = extOf(item.name);
      const ext = ['.jpg', '.jpeg', '.webp', '.avif', '.tif', '.tiff'].includes(srcExt) ? srcExt : '.png';
      const dir = path.dirname(absFile);
      const base = stemOf(item.name);
      let stem = `${base}-裁剪`;
      let seq = 1;
      const freeName = async (s) => {
        const candidate = path.join(dir, `${s}${ext}`);
        return !(await exists(candidate)) && !this._reserved.has(candidate.toLowerCase());
      };
      while (!(await freeName(stem))) {
        stem = `${base}-裁剪-${seq}`;
        seq += 1;
      }
      const dest = path.join(dir, `${stem}${ext}`);
      this._reserved.add(dest.toLowerCase());

      let tmp = path.join(dir, `.crop-${process.pid}-${Date.now()}${ext}`);
      let created = null;
      try {
        const written = await media.cropImageToFile(absFile, meta, rect, tmp);
        const hash = await sha256File(tmp);
        if (this._hashMap.has(hash)) throw new Error('相同裁剪结果已存在');
        const size = (await fsp.stat(tmp)).size;

        await fsp.rename(tmp, dest);
        tmp = null;

        created = this.newItem({
          type: 'image',
          name: path.basename(dest),
          ext,
          stillRel: this.rel(dest),
          size,
          hash,
          width: written.rect.width,
          height: written.rect.height,
          takenAt: item.takenAt,
          make: item.make,
          model: item.model,
          gps: item.gps,
          displaySupported: true,
        });
        this._registerItem(created);
        this.scheduleSave();
        await this.flush();
        return this.publicItem(created);
      } catch (e) {
        this._unregisterItem(created);
        if (tmp) await fsp.unlink(tmp).catch(() => {});
        await fsp.unlink(dest).catch(() => {});
        this._reserved.delete(dest.toLowerCase());
        throw e;
      }
    }

    if (!item.motionRel) throw new Error('该实况照片缺少动态视频，无法生成新的实况');
    const absStill = this.abs(item.stillRel);
    const absMotion = this.abs(item.motionRel);
    if (!(await exists(absStill))) throw new Error('原图文件不可用');
    if (!(await exists(absMotion))) throw new Error('实况视频文件不可用');
    const meta = await media.readMeta(absStill);
    if (!meta.width || !meta.height) throw new Error('无法读取原图尺寸');

    // 新实况与原图放在同一目录，静态图与视频同名，外部按 Live Photo 规则也能配对预览
    const dir = path.dirname(absStill);
    const base = stemOf(item.name);
    let stem = `${base}-裁剪`;
    let i = 1;
    const pairFree = async (s) => {
      const still = path.join(dir, `${s}.jpg`);
      const video = path.join(dir, `${s}.mp4`);
      return !(await exists(still)) && !(await exists(video))
        && !this._reserved.has(still.toLowerCase()) && !this._reserved.has(video.toLowerCase());
    };
    while (!(await pairFree(stem))) {
      stem = `${base}-裁剪-${i}`;
      i += 1;
    }
    const destStill = path.join(dir, `${stem}.jpg`);
    const destMotion = path.join(dir, `${stem}.mp4`);
    this._reserved.add(destStill.toLowerCase());
    this._reserved.add(destMotion.toLowerCase());

    const stamp = `${process.pid}-${Date.now()}`;
    let tmpStill = path.join(dir, `.crop-${stamp}.jpg`);
    let tmpMotion = path.join(dir, `.crop-${stamp}.mp4`);
    let tmpLive = path.join(dir, `.crop-${stamp}-live.jpg`);
    let created = null;

    try {
      const stillWritten = await media.cropImageToFile(absStill, meta, rect, tmpStill);
      const motionProbe = await media.cropVideoToFile(absMotion, tmpMotion, rect, { crf: 20 });
      // 单文件实况：把裁剪后的动态视频内嵌到 JPEG 尾部，外部悬浮预览也能播放裁剪内容
      await media.embedMotionPhoto(tmpStill, tmpMotion, tmpLive);
      await fsp.unlink(tmpStill).catch(() => {});
      tmpStill = null;
      const hash = await sha256File(tmpLive);
      if (this._hashMap.has(hash)) throw new Error('相同裁剪结果已存在');
      const size = (await fsp.stat(tmpLive)).size;

      await fsp.rename(tmpLive, destStill);
      tmpLive = null;
      await fsp.rename(tmpMotion, destMotion);
      tmpMotion = null;

      created = this.newItem({
        type: 'live',
        name: path.basename(destStill),
        ext: '.jpg',
        stillRel: this.rel(destStill),
        motionRel: this.rel(destMotion),
        motionKind: 'paired',
        motionStatus: 'ready',
        motionCodec: 'h264',
        motionDuration: motionProbe.duration || 0,
        motionFaststart: true,
        width: stillWritten.rect.width,
        height: stillWritten.rect.height,
        size,
        hash,
        takenAt: item.takenAt,
        make: item.make,
        model: item.model,
        gps: item.gps,
        displaySupported: true,
      });
      this._registerItem(created);
      this.scheduleSave();
      await this.flush();
      return this.publicItem(created);
    } catch (e) {
      this._unregisterItem(created);
      for (const f of [tmpStill, tmpMotion, tmpLive]) {
        if (f) await fsp.unlink(f).catch(() => {});
      }
      await fsp.unlink(destStill).catch(() => {});
      await fsp.unlink(destMotion).catch(() => {});
      this._reserved.delete(destStill.toLowerCase());
      this._reserved.delete(destMotion.toLowerCase());
      throw e;
    }
  }

  async exportCrop(id, destFile, crop) {
    const item = this.findById(id);
    if (!item) throw new Error('条目不存在');
    const rect = this.normalizeCrop(crop) || item.crop;
    if (!rect) throw new Error('该条目没有裁剪');
    const absFile = this.abs(item.stillRel);
    if (!(await exists(absFile))) throw new Error('原文件不可用');
    const meta = await media.readMeta(absFile);
    return media.exportCrop(absFile, meta, rect, destFile);
  }

  // ---------- 派生资源解析（供本地流媒体服务） ----------
  thumbCacheFile(item, size, withCrop) {
    const key = crypto.createHash('sha1')
      .update(`${item.id}|${item.updatedAt}|${size}|${withCrop ? 'c' : 'f'}`)
      .digest('hex');
    return path.join(this.thumbDir, `${key}.jpg`);
  }

  async ensureThumb(item, size = 420, withCrop = true) {
    if (item.type === 'video') {
      return this.ensureVideoCover(item, size);
    }
    const absFile = this.abs(item.stillRel);
    if (!(await exists(absFile))) return null;
    const out = this.thumbCacheFile(item, size, withCrop);
    if (await exists(out)) return out;
    const meta = await media.readMeta(absFile);
    const crop = withCrop ? item.crop : null;
    await media.buildThumb(absFile, meta, out, size, crop);
    return (await exists(out)) ? out : null;
  }

  async ensureVideoCover(item, size = 420) {
    const absVideo = this.abs(item.videoRel);
    if (!(await exists(absVideo))) return null;
    const key = crypto.createHash('sha1').update(`${item.id}|${item.updatedAt}|${size}`).digest('hex');
    const out = path.join(this.coverDir, `${key}.jpg`);
    if (await exists(out)) return out;
    return media.buildCover(absVideo, out, size);
  }

  async ensureFull(item, options = {}) {
    if (item.type === 'video') return null;
    const absFile = this.abs(item.stillRel);
    if (!(await exists(absFile))) return null;
    if (!item.displaySupported) return null;

    const ignoreCrop = Boolean(options.ignoreCrop);
    const crop = ignoreCrop ? null : item.crop;

    if (crop) {
      const key = crypto.createHash('sha1').update(`${item.id}|${item.updatedAt}|crop`).digest('hex');
      const out = path.join(this.fullDir, `${key}.png`);
      if (await exists(out)) return { file: out, mime: 'image/png', derived: true };
      const meta = await media.readMeta(absFile);
      await media.buildFullPng(absFile, meta, out, crop);
      return { file: out, mime: 'image/png', derived: true, cropped: true };
    }

    const ext = extOf(absFile);
    if (BROWSER_IMAGE_EXT.has(ext)) {
      return { file: absFile, mime: require('./util').mimeOf(absFile), derived: false };
    }

    const key = crypto.createHash('sha1').update(`${item.id}|${item.updatedAt}|full`).digest('hex');
    const out = path.join(this.fullDir, `${key}.png`);
    if (await exists(out)) return { file: out, mime: 'image/png', derived: true };
    const meta = await media.readMeta(absFile);
    await media.buildFullPng(absFile, meta, out, null);
    return { file: out, mime: 'image/png', derived: true };
  }

  async ensureMotionPlayable(item) {
    if (!item.motionRel) return { file: null, mode: 'none' };
    const absMotion = this.abs(item.motionRel);
    if (!(await exists(absMotion))) return { file: null, mode: 'missing' };
    // 裁剪保存时已生成 H.264/AAC + faststart 的新实况，直接原文件播放，无需任何转码或代理
    if (!item.crop && item.motionFaststart && item.motionCodec === 'h264') {
      return { file: absMotion, mode: 'direct', codec: 'h264' };
    }
    const key = crypto.createHash('sha1').update(`${item.id}|${item.motionRel}|${item.updatedAt}`).digest('hex');
    // 旧版已裁剪的实况：播放画面同步裁剪，与静态图保留区域一致
    return media.ensurePlayable(absMotion, this.proxyDir, key, item.crop);
  }

  async ensureVideoPlayable(item) {
    if (item.type !== 'video') return { file: null, mode: 'none' };
    const absVideo = this.abs(item.videoRel);
    if (!(await exists(absVideo))) return { file: null, mode: 'missing' };
    const key = crypto.createHash('sha1').update(`${item.id}|${item.videoRel}`).digest('hex');
    return media.ensurePlayable(absVideo, this.proxyDir, key);
  }

  // ---------- 完整性校验 ----------
  async verifyItem(id) {
    const item = this.findById(id);
    if (!item) throw new Error('条目不存在');
    const absFile = this.abs(item.stillRel || item.videoRel);
    if (!(await exists(absFile))) return { ok: false, reason: '文件缺失' };
    const hash = await sha256File(absFile);
    return { ok: hash === item.hash, expected: item.hash, actual: hash };
  }

  // ---------- 缓存清理 ----------
  async clearCache() {
    await fsp.rm(this.cacheDir, { recursive: true, force: true }).catch(() => {});
    for (const dir of [this.thumbDir, this.fullDir, this.proxyDir, this.coverDir]) await ensureDir(dir);
    return true;
  }

  // ---------- 库迁移 ----------
  async migrateTo(newRoot, onProgress = () => {}) {
    this.assertAvailable();
    const target = path.resolve(newRoot);
    if (target === this.root) throw new Error('目标目录与当前库相同');
    if (isInside(this.root, target)) throw new Error('目标目录不能位于当前库内部');
    if (isInside(target, this.root)) throw new Error('当前库不能位于目标目录内部');
    if (await exists(path.join(target, toNative(DIRS.meta), 'library.json'))) {
      throw new Error('目标目录已是另一个照片仓库，请换一个空目录');
    }
    await fsp.mkdir(target, { recursive: true });

    const relDirs = [DIRS.originals, DIRS.videos, DIRS.live, DIRS.derived, DIRS.trash];
    const allFiles = [];
    for (const rel of relDirs) {
      const found = await walk(path.join(this.root, toNative(rel)));
      for (const f of found) allFiles.push(f);
    }
    const total = allFiles.length;
    let done = 0;

    const created = [];
    try {
      for (const absSrc of allFiles) {
        const rel = this.rel(absSrc);
        const dest = path.join(target, toNative(rel));
        await ensureDir(path.dirname(dest));
        const expected = await sha256File(absSrc);
        await copyVerified(absSrc, dest, expected);
        created.push(dest);
        done += 1;
        onProgress({ phase: '迁移', done, total, current: path.basename(absSrc) });
      }
      // 索引随库迁移
      await ensureDir(path.join(target, toNative(DIRS.meta)));
      this.index.updatedAt = now();
      await atomicWriteJson(path.join(target, toNative(DIRS.meta), 'library.json'), this.index);
      await ensureDir(path.join(target, toNative(DIRS.cache)));
      return { ok: true, files: total, root: target };
    } catch (e) {
      // 迁移失败：不动原库；清理目标目录内本次写入的副本
      for (const f of created) {
        await fsp.unlink(f).catch(() => {});
      }
      const err = new Error(`迁移失败：${e.message}（原库未被修改，请重试或更换目标位置）`);
      err.code = 'MIGRATE_FAILED';
      throw err;
    }
  }
}

module.exports = { Library, DIRS };
