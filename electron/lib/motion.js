'use strict';

/**
 * 动态照片（实况）识别与无损抽取：
 * - Google Motion Photo：JPEG/HEIC 内嵌 MP4，XMP MicroVideoOffset / Container:Directory
 * - Samsung Motion Photo：JPEG 尾部追加 MP4（ftyp 启发式定位）
 * - iPhone Live Photo：同名 HEIC/JPG + MOV 配对（在 library 中处理）
 * 抽取只做“按边界切字节”，不转码；抽取件写入 Live/ 目录，原文件保持完整。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ensureDir, probeVideo, runFfmpeg, exists, stemOf, extOf } = require('./util');

const IPHONE_VIDEO_EXT = new Set(['.mov', '.mp4']);
const MIN_MOTION_BYTES = 1024;

function inspectXmp(buffer) {
  const head = buffer.subarray(0, Math.min(buffer.length, 512 * 1024)).toString('latin1');
  if (!head.includes('MotionPhoto') && !head.includes('MicroVideo')) return null;

  // 属性写法：MicroVideoOffset="12345"
  let m = head.match(/MicroVideoOffset\s*=\s*["'](\d+)["']/);
  // 元素写法：<GCamera:MicroVideoOffset>12345</GCamera:MicroVideoOffset>
  if (!m) m = head.match(/<[^>]*MicroVideoOffset[^>]*>\s*(\d+)\s*</);
  if (m) {
    const length = Number(m[1]);
    if (length > MIN_MOTION_BYTES && length < buffer.length) {
      return { start: buffer.length - length, length, kind: 'google' };
    }
  }

  // Container:Directory —— 取 Semantic=MotionPhoto 那一项的 Length
  const itemTags = head.split('<Item').slice(1);
  for (const tag of itemTags) {
    const headOfTag = tag.slice(0, tag.indexOf('>') + 1);
    if (/Semantic\s*=\s*["']MotionPhoto/i.test(headOfTag)) {
      const lm = headOfTag.match(/Length\s*=\s*["'](\d+)/);
      if (lm) {
        const length = Number(lm[1]);
        if (length > MIN_MOTION_BYTES && length < buffer.length) {
          return { start: buffer.length - length, length, kind: 'google' };
        }
      }
    }
  }
  return null;
}

/** 尾部追加 MP4 的启发式定位（Samsung / 部分 Android） */
function findAppendedMp4(buffer) {
  let p = buffer.lastIndexOf('ftyp');
  let best = null;
  let guard = 0;
  while (p > 4 && guard < 8) {
    guard += 1;
    const start = p - 4;
    const size = buffer.readUInt32BE(start);
    const brand = buffer.subarray(p + 4, p + 8).toString('latin1');
    const knownBrand = ['mp42', 'mp41', 'isom', 'M4V ', 'qt  ', 'avc1', 'dash', 'iso2', 'msnv'].includes(brand);
    if (knownBrand && size >= 16 && buffer.length - start > MIN_MOTION_BYTES) {
      best = { start, length: buffer.length - start, kind: 'samsung' };
      break;
    }
    p = buffer.lastIndexOf('ftyp', start - 1);
  }
  return best;
}

/** 返回 { start, length, kind } 或 null */
function detectEmbeddedMotion(buffer) {
  const xmp = inspectXmp(buffer);
  if (xmp) return xmp;
  return findAppendedMp4(buffer);
}

async function sliceToFile(srcFile, start, length, destFile) {
  await ensureDir(path.dirname(destFile));
  const tmp = `${destFile}.part`;
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(srcFile, { start, end: start + length - 1 });
    const ws = fs.createWriteStream(tmp);
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
  await fsp.rename(tmp, destFile);
}

/**
 * 从图片中抽取内嵌动态视频；成功返回 {ok, codec, duration, kind}
 * 抽取件若因尾部杂质无法解码，则用无损 remux 清洗（内容流不重编码）。
 */
async function extractEmbeddedMotion(absImage, destFile) {
  let buffer;
  try {
    const st = await fsp.stat(absImage);
    if (st.size > 1024 * 1024 * 1024) return { ok: false, reason: '文件过大，跳过内嵌扫描' };
    buffer = await fsp.readFile(absImage);
  } catch (e) {
    return { ok: false, reason: String(e) };
  }

  const found = detectEmbeddedMotion(buffer);
  if (!found) return { ok: false, reason: '未发现内嵌动态段' };

  try {
    await sliceToFile(absImage, found.start, found.length, destFile);
  } catch (e) {
    return { ok: false, reason: `抽取失败：${e.message}` };
  }

  let probe = await probeVideo(destFile);
  if (!probe.ok) {
    const clean = destFile.replace(/(\.mp4)?$/i, '.clean.mp4');
    const r = await runFfmpeg(['-i', destFile, '-c', 'copy', '-movflags', '+faststart', clean], 120000);
    if (r.code === 0 && (await exists(clean))) {
      await fsp.rename(clean, destFile).catch(async () => {
        await fsp.copyFile(clean, destFile);
        await fsp.unlink(clean).catch(() => {});
      });
      probe = await probeVideo(destFile);
    }
  }
  if (!probe.ok) return { ok: false, reason: '内嵌视频无法解码（已保留原文件）' };

  return {
    ok: true, kind: found.kind, codec: probe.codec,
    duration: probe.duration, width: probe.width, height: probe.height,
    bytes: found.length,
  };
}

/** 同一批次中判定 iPhone 实况配对（同目录、同主名、图 + MOV/MP4） */
function pairKey(filePath) {
  return `${path.dirname(filePath).toLowerCase()}\\${stemOf(filePath).toLowerCase()}`;
}

function isLiveVideoPartner(imagePath, videoPath) {
  if (!IPHONE_VIDEO_EXT.has(extOf(videoPath))) return false;
  if (path.dirname(imagePath).toLowerCase() !== path.dirname(videoPath).toLowerCase()) return false;
  return stemOf(imagePath).toLowerCase() === stemOf(videoPath).toLowerCase();
}

module.exports = {
  detectEmbeddedMotion, extractEmbeddedMotion, pairKey, isLiveVideoPartner, inspectXmp,
};
