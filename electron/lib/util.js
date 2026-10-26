'use strict';

/**
 * 通用工具：哈希、字节级复制校验、原子写 JSON、ffmpeg 调用与视频探测。
 * 该文件不依赖 Electron，可在主进程与脚本中复用。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

let ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
if (ffmpegPath.includes('app.asar')) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.heif']);
const RAW_EXT = new Set(['.dng', '.cr2', '.nef', '.arw', '.raf', '.orf', '.rw2', '.srw']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
// Chromium 可直接解码的静态图格式（无需派生件）
const BROWSER_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
// 浏览器可直接播放的编码（其余走兼容预览）
const BROWSER_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.heic': 'image/heic',
  '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

function extOf(file) {
  return path.extname(file || '').toLowerCase();
}

/** 取主文件名，兼容大小写扩展名（path.basename 的后缀匹配区分大小写） */
function stemOf(file) {
  const base = path.basename(file || '');
  const ext = path.extname(base);
  return ext ? base.slice(0, base.length - ext.length) : base;
}

function toNative(rel) {
  return String(rel || '').split('/').join(path.sep);
}

function toPosix(rel) {
  return String(rel || '').split(path.sep).join('/');
}

function mimeOf(file) {
  return MIME[extOf(file)] || 'application/octet-stream';
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on('data', (c) => hash.update(c));
    s.on('error', reject);
    s.on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * 字节级原样复制：用 fs.copyFile 走系统复制，再对目标文件计算 SHA-256，原子改名。
 * 传入 expectedHash 时会校验目标与期望一致。返回 { hash, size }，失败不留下半成品。
 */
async function copyVerified(src, dst, expectedHash = null) {
  const tmp = `${dst}.part-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fsp.copyFile(src, tmp);
    const dstHash = await sha256File(tmp);
    if (expectedHash && dstHash !== expectedHash) {
      throw new Error('字节校验失败：复制前后不一致');
    }
    const st = await fsp.stat(tmp);
    await fsp.rename(tmp, dst);
    return { hash: dstHash, size: st.size };
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

async function atomicWriteJson(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const text = JSON.stringify(data);
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback = null) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 在同目录下生成不冲突的文件名（保留原文件名，冲突时追加 -n） */
async function uniqueFile(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let i = 1;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    i += 1;
  }
  return candidate;
}

function runFfmpeg(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    let err = '';
    let proc;
    try {
      proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stderr: String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve({ code: -1, stderr: 'ffmpeg timeout' });
    }, timeoutMs);
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stderr: String(e) }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr: err }); });
  });
}

/** 用 ffmpeg -i 探测容器/编码/时长（无 ffprobe 依赖） */
function probeVideo(file, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e) }); });
    proc.on('close', () => {
      clearTimeout(timer);
      const codecMatch = out.match(/Video:\s*([a-zA-Z0-9_]+)/);
      const durMatch = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const sizeMatch = out.match(/,\s*(\d{2,5})x(\d{2,5})/);
      const duration = durMatch
        ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3])
        : 0;
      resolve({
        ok: Boolean(codecMatch),
        codec: codecMatch ? codecMatch[1].toLowerCase() : null,
        duration,
        width: sizeMatch ? Number(sizeMatch[1]) : 0,
        height: sizeMatch ? Number(sizeMatch[2]) : 0,
        raw: out,
      });
    });
  });
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

module.exports = {
  ffmpegPath,
  IMAGE_EXT, RAW_EXT, VIDEO_EXT, BROWSER_IMAGE_EXT, BROWSER_VIDEO_CODECS,
  extOf, toNative, toPosix, mimeOf, ensureDir, exists, stemOf,
  sha256File, copyVerified, atomicWriteJson, readJson, uniqueFile,
  runFfmpeg, probeVideo, round4, clamp01, formatBytes,
};
