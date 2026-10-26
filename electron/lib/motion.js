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
// 内嵌探测的分段读取窗口：XMP 只在头部；追加 MP4 通过 JPEG EOI / HEIC 顶层 box 定位
const HEAD_SCAN_BYTES = 512 * 1024;
const TAIL_SCAN_BYTES = 256 * 1024;
const EOI_PADDING = 64; // JPEG EOI 之后允许的尾部填充字节数

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

// ---------------- 快速探测：避免为确认“无动态段”而整读文件 ----------------

/** 头部 XMP 扫描（Google Motion Photo）；与 inspectXmp 同逻辑，但只依赖头 512KB + 文件总大小 */
function inspectXmpHead(headStr, fileSize) {
  if (!headStr.includes('MotionPhoto') && !headStr.includes('MicroVideo')) return null;

  let m = headStr.match(/MicroVideoOffset\s*=\s*["'](\d+)["']/);
  if (!m) m = headStr.match(/<[^>]*MicroVideoOffset[^>]*>\s*(\d+)\s*</);
  if (m) {
    const length = Number(m[1]);
    if (length > MIN_MOTION_BYTES && length < fileSize) {
      return { start: fileSize - length, length, kind: 'google' };
    }
  }

  const itemTags = headStr.split('<Item').slice(1);
  for (const tag of itemTags) {
    const headOfTag = tag.slice(0, tag.indexOf('>') + 1);
    if (/Semantic\s*=\s*["']MotionPhoto/i.test(headOfTag)) {
      const lm = headOfTag.match(/Length\s*=\s*["'](\d+)/);
      if (lm) {
        const length = Number(lm[1]);
        if (length > MIN_MOTION_BYTES && length < fileSize) {
          return { start: fileSize - length, length, kind: 'google' };
        }
      }
    }
  }
  return null;
}

/** 在追加区缓冲内定位 MP4 ftyp（与 findAppendedMp4 同启发式，坐标换算到全文件；允许区首即 ftyp） */
function scanAppendedMp4Region(regionBuf, regionStart, fileSize) {
  let p = regionBuf.lastIndexOf('ftyp');
  let guard = 0;
  while (p >= 4 && guard < 8) {
    guard += 1;
    const start = p - 4;
    const size = regionBuf.readUInt32BE(start);
    const brand = regionBuf.subarray(p + 4, p + 8).toString('latin1');
    const knownBrand = ['mp42', 'mp41', 'isom', 'M4V ', 'qt  ', 'avc1', 'dash', 'iso2', 'msnv'].includes(brand);
    const globalStart = regionStart + start;
    if (knownBrand && size >= 16 && globalStart > 0 && fileSize - globalStart > MIN_MOTION_BYTES) {
      return { start: globalStart, length: fileSize - globalStart, kind: 'samsung' };
    }
    p = regionBuf.lastIndexOf('ftyp', start - 1);
  }
  return null;
}

async function readRange(fh, start, length) {
  const buf = Buffer.allocUnsafe(length);
  const { bytesRead } = await fh.read(buf, 0, length, start);
  return bytesRead === length ? buf : buf.subarray(0, bytesRead);
}

/** 在尾部窗口内找最后一个 JPEG EOI(FFD9)，返回其后一个字节的全局偏移；找不到返回 -1 */
function findJpegEoiEnd(tailBuf, tailStart) {
  for (let i = tailBuf.length - 2; i >= 0; i--) {
    if (tailBuf[i] === 0xff && tailBuf[i + 1] === 0xd9) {
      return tailStart + i + 2;
    }
  }
  return -1;
}

/**
 * 在窗口内找「JPEG EOI + 追加 MP4 头」的结构边界。
 * 只认 EOI(FFD9)（允许少量填充）紧跟合法 ftyp box 的位置：
 * 追加视频的数据里可能散落 FFD9 字节，直接取“最后一个 EOI”会把边界算进视频里，
 * 导致实况被误判为静态图。返回 { start, length, kind } 或 null。
 */
function findAppendedAfterJpegEoi(buf, bufStart, fileSize) {
  let p = buf.lastIndexOf('ftyp');
  let guard = 0;
  while (p >= 4 && guard < 16) {
    guard += 1;
    const boxStart = p - 4;
    const boxSize = buf.readUInt32BE(boxStart);
    const brand = buf.subarray(p + 4, p + 8).toString('latin1');
    const knownBrand = ['mp42', 'mp41', 'isom', 'M4V ', 'qt  ', 'avc1', 'dash', 'iso2', 'msnv'].includes(brand);
    if (knownBrand && boxSize >= 16) {
      let e = boxStart - 1;
      const minE = Math.max(1, boxStart - EOI_PADDING);
      while (e >= minE && (buf[e] === 0x00 || buf[e] === 0x20 || buf[e] === 0x0a || buf[e] === 0x0d)) e -= 1;
      if (e >= 1 && buf[e - 1] === 0xff && buf[e] === 0xd9) {
        const start = bufStart + e + 1;
        if (fileSize - start > MIN_MOTION_BYTES) {
          return { start, length: fileSize - start, kind: 'samsung' };
        }
      }
      // ftyp 合法但 EOI 不在本窗口内（追加视频很大）：交由调用方扩大窗口
      return null;
    }
    p = buf.lastIndexOf('ftyp', boxStart - 1);
  }
  return null;
}

/**
 * 走 HEIC 顶层 ISO-BMFF box 结构，定位追加内容起点：
 * - 返回文件大小 → 无追加内容；
 * - 返回 <size 的偏移 → 追加内容起点（第二个顶层 ftyp，或尾部残留）；
 * - 返回 -1 → 结构异常，调用方需全读兜底。
 */
async function findHeicAppendageStart(fh, size) {
  let pos = 0;
  let ftypSeen = false;
  for (let i = 0; i < 64; i++) {
    if (pos >= size) return size;
    if (size - pos < 8) return pos; // 不足一个 box 头的尾部残留 → 视为追加内容
    const hdr = await readRange(fh, pos, 8);
    if (hdr.length < 8) return -1;
    let boxSize = hdr.readUInt32BE(0);
    const type = hdr.subarray(4, 8).toString('latin1');
    let headerSize = 8;
    if (boxSize === 1) {
      const ext = await readRange(fh, pos + 8, 8);
      if (ext.length < 8) return -1;
      boxSize = Number(ext.readBigUInt64BE(0));
      headerSize = 16;
    } else if (boxSize === 0) {
      return size; // size==0 的 box 延伸到文件末尾
    }
    if (boxSize < headerSize) return -1;
    if (type === 'ftyp') {
      if (ftypSeen) return pos; // 第二个顶层 ftyp → 追加的 MP4
      ftypSeen = true;
    }
    if (pos + boxSize > size) return pos; // box 越过 EOF → 此处起为追加/异常内容
    pos += boxSize;
  }
  return -1;
}

/**
 * 快速定位内嵌动态段：命中或确认无时都只读头/尾小窗口；
 * 仅在结构异常等少见情形下退回整文件读取，保证检测结果与全量扫描一致。
 */
async function detectEmbeddedMotionInFile(absImage) {
  const st = await fsp.stat(absImage);
  const size = st.size;
  if (size <= MIN_MOTION_BYTES) return null;

  const fh = await fsp.open(absImage, 'r');
  try {
    // 1) 头部 XMP（Google 等基于 XMP 标记的动态照片）
    const headLen = Math.min(size, HEAD_SCAN_BYTES);
    const headBuf = await readRange(fh, 0, headLen);
    const xmp = inspectXmpHead(headBuf.toString('latin1'), size);
    if (xmp) return xmp;

    const ext = extOf(absImage);
    if (ext === '.jpg' || ext === '.jpeg') {
      // 2a) JPEG：先认「EOI + 合法 MP4 头」的结构边界；追加视频很大时逐级放大尾部窗口，
      //     避免把追加视频里散落的 FFD9 当成 JPEG 结尾而漏判实况
      let win = Math.min(size, TAIL_SCAN_BYTES);
      let buf = await readRange(fh, size - win, win);
      while (true) {
        const found = findAppendedAfterJpegEoi(buf, size - win, size);
        if (found) return found;
        // 尾部 EOI 紧贴文件末尾，且窗口内没有合法的追加 MP4 边界 → 普通静态照片
        const eoiEnd = findJpegEoiEnd(buf, size - win);
        if (eoiEnd >= 0 && size - eoiEnd <= EOI_PADDING) return null;
        if (win >= size) {
          // 结构异常（截断等）：与旧行为一致，全量扫描兜底
          return detectEmbeddedMotion(buf);
        }
        win = Math.min(size, win * 4);
        buf = await readRange(fh, size - win, win);
      }
    }
    if (ext === '.heic' || ext === '.heif') {
      // 2b) HEIC：顶层 box 走查定位容器末尾（Samsung 类追加段在容器外）
      const appendStart = await findHeicAppendageStart(fh, size);
      if (appendStart < 0) {
        const full = await fsp.readFile(absImage);
        return detectEmbeddedMotion(full);
      }
      if (appendStart === size || size - appendStart <= MIN_MOTION_BYTES) return null;
      const region = await readRange(fh, appendStart, size - appendStart);
      return scanAppendedMp4Region(region, appendStart, size);
    }
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
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
  let found;
  try {
    const st = await fsp.stat(absImage);
    if (st.size > 1024 * 1024 * 1024) return { ok: false, reason: '文件过大，跳过内嵌扫描' };
    // 快速探测：普通静态照片只读头/尾小窗口，不再整读文件
    found = await detectEmbeddedMotionInFile(absImage);
  } catch (e) {
    return { ok: false, reason: String(e) };
  }

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
  if (!probe.ok) {
    // 已确认存在内嵌动态段、只是解码器不支持：保留抽取件并回报 detected，
    // 让调用方按「实况（待支持）」归类，而不是把实况误判成静态图
    return { ok: false, detected: true, kind: found.kind, bytes: found.length, reason: '内嵌视频无法解码（已保留原文件）' };
  }

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
  detectEmbeddedMotion, detectEmbeddedMotionInFile, extractEmbeddedMotion, pairKey, isLiveVideoPartner, inspectXmp,
};
