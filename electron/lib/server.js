'use strict';

/**
 * 本地只读媒流服务：仅监听 127.0.0.1，带会话令牌。
 * 提供缩略图、全尺寸无损视图、动态照片视频流（支持 Range，便于拖动/循环播放）。
 * 不暴露任意路径，只能按索引 id 取件。
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const path = require('path');

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};

class MediaServer {
  constructor() {
    this.server = null;
    this.port = 0;
    this.token = crypto.randomBytes(16).toString('hex');
    this.library = null;
    this._inflight = new Map();
    this.previewDir = null;
    // 解码/转码并发闸门：滚动网格时瞬间涌入大量缩略图请求，
    // 不限制会让 sharp/ffmpeg 同时开工，CPU 与内存被打满
    this._workActive = 0;
    this._workQueue = [];
    this._workLimit = 4;
  }

  /** 并发闸门：超过上限的请求排队等待空位 */
  async _gateWork(fn) {
    if (this._workActive >= this._workLimit) {
      await new Promise((resolve) => this._workQueue.push(resolve));
    }
    this._workActive += 1;
    try {
      return await fn();
    } finally {
      this._workActive -= 1;
      const next = this._workQueue.shift();
      if (next) next();
    }
  }

  setLibrary(library) { this.library = library; }

  /** 手机导入预览图目录（仅允许读取该目录下的封面文件） */
  setPreviewDir(dir) { this.previewDir = dir; }

  previewUrl(name) {
    return `${this.baseUrl()}/p/${this.token}/${encodeURIComponent(name)}`;
  }

  baseUrl() { return `http://127.0.0.1:${this.port}`; }

  url(kind, id, query = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    return `${this.baseUrl()}/m/${this.token}/${kind}/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`;
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => { this.handle(req, res); });
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
    return this;
  }

  stop() {
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
    }
  }

  async handle(req, res) {
    const started = Date.now();
    try {
      const parsed = new URL(req.url, this.baseUrl());
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0] === 'health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, library: Boolean(this.library) }));
        return;
      }
      if (parts[0] === 'p') {
        if (parts[1] !== this.token) { this.reply(res, 403, 'Forbidden'); return; }
        const name = decodeURIComponent(parts[2] || '');
        if (!this.previewDir || !/^[a-z0-9]+\.jpg$/.test(name)) { this.reply(res, 404, 'Not found'); return; }
        const file = path.join(this.previewDir, name);
        await this.serveFile(req, res, file, 'image/jpeg', 'private, max-age=3600');
        return;
      }
      if (parts[0] !== 'm' || parts[1] !== this.token) {
        this.reply(res, 403, 'Forbidden');
        return;
      }
      if (!this.library) { this.reply(res, 503, 'No library opened'); return; }
      const kind = parts[2];
      const id = decodeURIComponent(parts[3] || '');
      const item = this.library.findById(id);
      if (!item) { this.reply(res, 404, 'Item not found'); return; }

      const size = Math.max(64, Math.min(2048, Number(parsed.searchParams.get('s')) || 420));
      const withCrop = parsed.searchParams.get('crop') !== '0';
      const key = `${kind}:${id}:${size}:${withCrop}`;

      let task = this._inflight.get(key);
      if (!task) {
        task = this._gateWork(() => this.resolve(kind, item, size, withCrop));
        this._inflight.set(key, task);
        task.finally(() => this._inflight.delete(key));
      }
      const resolved = await task;
      if (!resolved || !resolved.file) { this.reply(res, 404, 'Not available'); return; }

      await this.serveFile(req, res, resolved.file, resolved.mime, resolved.cacheControl);
      if (process.env.PHOTO_REPO_DEBUG) {
        console.log(`[media] ${kind} ${id} ${Date.now() - started}ms`);
      }
    } catch (e) {
      if (!res.headersSent) this.reply(res, 500, String(e && e.message ? e.message : e));
    }
  }

  async resolve(kind, item, size, withCrop) {
    if (kind === 'thumb') {
      const file = await this.library.ensureThumb(item, size, withCrop);
      return file ? { file, mime: 'image/jpeg', cacheControl: 'public, max-age=86400' } : null;
    }
    if (kind === 'full') {
      const r = await this.library.ensureFull(item);
      return r ? { ...r, cacheControl: 'public, max-age=86400' } : null;
    }
    if (kind === 'source') {
      // 裁剪编辑器使用：始终返回未裁剪的原图视图
      const r = await this.library.ensureFull(item, { ignoreCrop: true });
      return r ? { ...r, cacheControl: 'public, max-age=86400' } : null;
    }
    if (kind === 'live') {
      const r = await this.library.ensureMotionPlayable(item);
      return r && r.file ? { file: r.file, mime: 'video/mp4', cacheControl: 'public, max-age=86400' } : null;
    }
    if (kind === 'video') {
      const r = await this.library.ensureVideoPlayable(item);
      return r && r.file ? { file: r.file, mime: 'video/mp4', cacheControl: 'public, max-age=86400' } : null;
    }
    return null;
  }

  reply(res, code, text) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
  }

  async serveFile(req, res, file, mime, cacheControl) {
    let stat;
    try { stat = await fsp.stat(file); } catch { this.reply(res, 404, 'File missing'); return; }
    const total = stat.size;
    const type = mime || CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? Number(m[1]) : 0;
      let end = m && m[2] ? Number(m[2]) : total - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= total) end = total - 1;
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl || 'public, max-age=86400',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl || 'public, max-age=86400',
    });
    fs.createReadStream(file).pipe(res);
  }
}

module.exports = { MediaServer };
