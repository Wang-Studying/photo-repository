'use strict';

/**
 * 媒体系列能力：
 * - EXIF/尺寸/拍摄时间读取（JPEG/TIFF/HEIC/AVIF）
 * - HEIC 解码（libheif WASM），不依赖系统扩展
 * - 缩略图 / 全尺寸无损派生图（PNG）/ 裁剪派生件
 * - 动态照片视频的可播放化（无损 remux；HEVC 等走兼容预览）
 * 所有派生件只写入 .photo-repo/cache 或 Derived，绝不会改写原文件。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const sharp = require('sharp');
const exifr = require('exifr');
const heicDecode = require('heic-decode');
const {
  extOf, exists, ensureDir, runFfmpeg, probeVideo, BROWSER_VIDEO_CODECS,
} = require('./util');

/** 从 HEIF 容器里读 ispe 尺寸，避免整图解码 */
function heicSize(buffer) {
  const limit = Math.min(buffer.length - 16, 1024 * 1024);
  let best = { width: 0, height: 0 };
  for (let i = 4; i < limit; i += 1) {
    if (buffer[i] === 0x69 && buffer[i + 1] === 0x73 && buffer[i + 2] === 0x70 && buffer[i + 3] === 0x65) {
      // 'ispe' box: type(4) + version/flags(4) + width(4) + height(4)
      const w = buffer.readUInt32BE(i + 8);
      const h = buffer.readUInt32BE(i + 12);
      if (w > 0 && h > 0 && w < 100000 && h < 100000 && w * h > best.width * best.height) {
        best = { width: w, height: h };
      }
    }
  }
  return best;
}

async function decodeHeicFile(file) {
  const buffer = await fsp.readFile(file);
  const result = await heicDecode({ buffer });
  return { data: Buffer.from(result.data), width: result.width, height: result.height };
}

function isHeic(file) {
  const e = extOf(file);
  return e === '.heic' || e === '.heif';
}

/** 读取媒体元数据；失败时退化为文件系统时间与 0 尺寸 */
async function readMeta(file) {
  const ext = extOf(file);
  const meta = {
    width: 0, height: 0, takenAt: null, make: '', model: '', lens: '',
    orientation: 1, gps: null, duration: 0, format: ext.replace('.', ''),
  };
  try {
    const ex = await exifr.parse(file, {
      pick: [
        'DateTimeOriginal', 'CreateDate', 'ModifyDate', 'Make', 'Model', 'LensModel',
        'Orientation', 'ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight',
        'GPSLatitude', 'GPSLongitude', 'ISO', 'FNumber', 'ExposureTime', 'FocalLength',
      ],
    });
    if (ex) {
      if (ex.DateTimeOriginal) meta.takenAt = new Date(ex.DateTimeOriginal).getTime();
      else if (ex.CreateDate) meta.takenAt = new Date(ex.CreateDate).getTime();
      meta.make = ex.Make || '';
      meta.model = ex.Model || '';
      meta.lens = ex.LensModel || '';
      if (ex.Orientation) meta.orientation = Number(ex.Orientation) || 1;
      if (ex.ExifImageWidth) { meta.width = Number(ex.ExifImageWidth); meta.height = Number(ex.ExifImageHeight) || 0; }
      if (!meta.width && ex.ImageWidth) { meta.width = Number(ex.ImageWidth); meta.height = Number(ex.ImageHeight) || 0; }
      if (ex.GPSLatitude != null && ex.GPSLongitude != null) {
        meta.gps = { lat: ex.GPSLatitude, lon: ex.GPSLongitude };
      }
      meta.exposure = {
        iso: ex.ISO || null, fnumber: ex.FNumber || null,
        exposureTime: ex.ExposureTime || null, focalLength: ex.FocalLength || null,
      };
    }
  } catch { /* EXIF 缺失不阻塞导入 */ }

  if (isHeic(file) && (!meta.width || !meta.height)) {
    try {
      const buf = await fsp.readFile(file);
      const size = heicSize(buf);
      if (size.width) { meta.width = size.width; meta.height = size.height; }
    } catch {}
  }

  if (!meta.width || !meta.height) {
    try {
      // 读入 Buffer 再交给 sharp：sharp(路径) 会让 libvips 直接打开文件，
      // Windows 上句柄要等 GC 才释放，期间删除/移动该文件会报 EBUSY
      const buf = await fsp.readFile(file);
      const m = await sharp(buf, { failOn: 'none' }).metadata();
      meta.width = m.width || meta.width;
      meta.height = m.height || meta.height;
      if (!meta.orientation || meta.orientation === 1) meta.orientation = m.orientation || 1;
    } catch {}
  }

  // 按 EXIF 方向换算显示尺寸（5~8 为 90° 旋转）
  if (meta.orientation >= 5 && meta.orientation <= 8) {
    const t = meta.width; meta.width = meta.height; meta.height = t;
  }

  if (!meta.takenAt) {
    try { meta.takenAt = (await fsp.stat(file)).mtimeMs; } catch { meta.takenAt = Date.now(); }
  }
  return meta;
}

async function readVideoMeta(file) {
  const probe = await probeVideo(file);
  const meta = {
    width: probe.width || 0, height: probe.height || 0, duration: probe.duration || 0,
    codec: probe.codec, format: extOf(file).replace('.', ''), takenAt: null,
    make: '', model: '',
  };
  try { meta.takenAt = (await fsp.stat(file)).mtimeMs; } catch { meta.takenAt = Date.now(); }
  try {
    const ex = await exifr.parse(file, { pick: ['CreateDate', 'DateTimeOriginal', 'Make', 'Model'] });
    if (ex) {
      if (ex.CreateDate) meta.takenAt = new Date(ex.CreateDate).getTime();
      else if (ex.DateTimeOriginal) meta.takenAt = new Date(ex.DateTimeOriginal).getTime();
      meta.make = ex.Make || '';
      meta.model = ex.Model || '';
    }
  } catch {}
  return meta;
}

/** 归一化裁剪矩形 → 像素矩形（左对齐取整，保证不重采样、像素精确） */
function pixelRect(crop, width, height) {
  const cx = Math.max(0, Math.min(1, Number(crop.x) || 0));
  const cy = Math.max(0, Math.min(1, Number(crop.y) || 0));
  const cw = Math.max(0.001, Math.min(1 - cx, Number(crop.w) || 1));
  const ch = Math.max(0.001, Math.min(1 - cy, Number(crop.h) || 1));
  const left = Math.min(width - 1, Math.round(cx * width));
  const top = Math.min(height - 1, Math.round(cy * height));
  const w = Math.max(1, Math.min(width - left, Math.round(cw * width)));
  const h = Math.max(1, Math.min(height - top, Math.round(ch * height)));
  return { left, top, width: w, height: h };
}

/** 生成带方向的 sharp 实例（HEIC 走 WASM 解码） */
async function orientedImage(absFile, meta) {
  if (isHeic(absFile)) {
    const { data, width, height } = await decodeHeicFile(absFile);
    return {
      image: sharp(data, { raw: { width, height, channels: 4 } }),
      width, height,
    };
  }
  // 用 Buffer 作输入：sharp(路径) 由 libvips 持有文件句柄，Windows 上要等 GC 才释放，
  // 期间对原文件做删除/移入回收站会 EBUSY；读进内存则句柄即刻释放
  const buf = await fsp.readFile(absFile);
  const image = sharp(buf, { failOn: 'none' }).rotate();
  const m = await image.metadata();
  const w = m.autoOrient?.width || m.width || meta?.width || 0;
  const h = m.autoOrient?.height || m.height || meta?.height || 0;
  return { image, width: w, height: h };
}

/** 网格缩略图（仅显示层缩放，JPEG 缓存） */
async function buildThumb(absFile, meta, outFile, maxSize, crop) {
  await ensureDir(path.dirname(outFile));
  const { image, width, height } = await orientedImage(absFile, meta);
  let pipe = image;
  if (crop && width && height) pipe = pipe.extract(pixelRect(crop, width, height));
  await pipe
    .resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 84, chromaSubsampling: '4:2:0', mozjpeg: true })
    .toFile(outFile);
  return outFile;
}

/** 全尺寸无损派生（PNG）：仅用于浏览器无法直接解码的格式或裁剪视图 */
async function buildFullPng(absFile, meta, outFile, crop) {
  await ensureDir(path.dirname(outFile));
  const { image, width, height } = await orientedImage(absFile, meta);
  let pipe = image;
  if (crop && width && height) pipe = pipe.extract(pixelRect(crop, width, height));
  await pipe.png({ compressionLevel: 4, adaptiveFiltering: true }).toFile(outFile);
  return outFile;
}

/** 视频封面帧（用于纯视频与实况静态兜底） */
async function buildCover(absVideo, outFile, size = 480) {
  await ensureDir(path.dirname(outFile));
  const filter = `scale='min(${size},iw)':-2`;
  let r = await runFfmpeg(['-ss', '0.15', '-i', absVideo, '-frames:v', '1', '-vf', filter, '-q:v', '4', outFile], 60000);
  if (r.code !== 0 || !(await exists(outFile))) {
    r = await runFfmpeg(['-i', absVideo, '-frames:v', '1', '-vf', filter, '-q:v', '4', outFile], 60000);
  }
  return (await exists(outFile)) ? outFile : null;
}

function filterCacheable(filePath) {
  return /\.(mp4|m4v|mov|webm)$/i.test(filePath);
}

/**
 * 归一化裁剪矩形 → ffmpeg crop 表达式。
 * 使用 iw/ih 而非探测宽度，可自动适配带旋转元数据的视频（ffmpeg 解码后画面已转正）。
 * 宽高与偏移均取偶数，满足 yuv420p 编码要求。
 */
function cropFilter(crop) {
  const c = crop || {};
  const cx = Math.max(0, Math.min(1, Number(c.x) || 0));
  const cy = Math.max(0, Math.min(1, Number(c.y) || 0));
  const cw = Math.max(0.001, Math.min(1 - cx, Number(c.w) || 1));
  const ch = Math.max(0.001, Math.min(1 - cy, Number(c.h) || 1));
  const n = (v) => String(Math.round(v * 10000) / 10000);
  // 最小 2px：极小选区若取偶后为 0，yuv420p 编码会直接失败
  return `crop=w='max(2,trunc(iw*${n(cw)}/2)*2)':h='max(2,trunc(ih*${n(ch)}/2)*2)':x='trunc(iw*${n(cx)}/2)*2':y='trunc(ih*${n(cy)}/2)*2'`;
}

/**
 * 校验缓存的派生视频是否完好：上次转码被中断会留下 0 字节/半截文件，
 * 只查存在性会把坏文件拿去播放导致永远解码失败
 */
async function validVideoCache(file) {
  try {
    const st = await fsp.stat(file);
    if (!st.size) return false;
    const probe = await probeVideo(file, 8000);
    return probe.ok;
  } catch { return false; }
}

/**
 * 实况视频的可播放化：
 * 1) 编码浏览器支持且未裁剪 → 无损 remux 为 faststart MP4（字节内容不解码、不重编码）
 * 2) 已裁剪 → 按裁剪范围重编码为 H.264 代理，播放画面与裁剪后的静态图一致
 * 3) HEVC 等 → 生成 H.264 兼容预览（仅播放使用，缓存可重建，原件零改写）
 */
async function ensurePlayable(motionAbs, cacheDir, key, crop) {
  await ensureDir(cacheDir);
  const probe = await probeVideo(motionAbs);
  if (!probe.ok) return { file: null, mode: 'unsupported', codec: probe.codec || null };

  const hasCrop = Boolean(crop);

  if (!hasCrop && BROWSER_VIDEO_CODECS.has(probe.codec) && filterCacheable(motionAbs)) {
    const remux = path.join(cacheDir, `${key}-play.mp4`);
    if (await exists(remux)) {
      if (await validVideoCache(remux)) return { file: remux, mode: 'remux', codec: probe.codec };
      await fsp.unlink(remux).catch(() => {});
    }
    const r = await runFfmpeg(['-i', motionAbs, '-c', 'copy', '-movflags', '+faststart', remux], 120000);
    if (r.code === 0 && (await validVideoCache(remux))) return { file: remux, mode: 'remux', codec: probe.codec };
    await fsp.unlink(remux).catch(() => {});
  }

  const proxy = path.join(cacheDir, `${key}${hasCrop ? '-crop' : ''}-proxy.mp4`);
  if (await exists(proxy)) {
    if (await validVideoCache(proxy)) return { file: proxy, mode: 'proxy', codec: 'h264' };
    await fsp.unlink(proxy).catch(() => {});
  }
  const filters = [];
  if (hasCrop) filters.push(cropFilter(crop));
  filters.push("scale='trunc(min(1280,iw)/2)*2':-2");
  const r = await runFfmpeg([
    '-i', motionAbs,
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', filters.join(','),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', proxy,
  ], 180000);
  if (r.code === 0 && (await validVideoCache(proxy))) return { file: proxy, mode: 'proxy', codec: 'h264' };
  await fsp.unlink(proxy).catch(() => {});
  return { file: null, mode: 'unsupported', codec: probe.codec || null };
}

/** 感知哈希（dHash，64 位十六进制）：用于相似照片检测，对缩放/轻微调色鲁棒 */
async function pHash(absFile) {
  const { image } = await orientedImage(absFile, null);
  const raw = await image.resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (raw[y * 9 + x] > raw[y * 9 + x + 1]) bits |= (1n << BigInt(y * 8 + x));
    }
  }
  return bits.toString(16).padStart(16, '0');
}

/** 两个 dHash 的汉明距离（0-64，越小越相似，≤6 通常视为同一构图） */
function hammingHex(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) { x &= (x - 1n); n++; }
  return n;
}

/** 将裁剪结果写入指定图片文件（保留原格式；HEIC/RAW 等无法回写的格式转为 PNG） */
async function cropImageToFile(absFile, meta, crop, destFile) {
  await ensureDir(path.dirname(destFile));
  const { image, width, height } = await orientedImage(absFile, meta);
  const rect = pixelRect(crop, width, height);
  const pipe = image.extract(rect);
  const ext = extOf(destFile);
  if (ext === '.jpg' || ext === '.jpeg') {
    await pipe.jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true }).toFile(destFile);
  } else if (ext === '.webp') {
    await pipe.webp({ lossless: true }).toFile(destFile);
  } else if (ext === '.avif') {
    await pipe.avif({ quality: 92 }).toFile(destFile);
  } else if (ext === '.tif' || ext === '.tiff') {
    await pipe.tiff({ compression: 'lzw' }).toFile(destFile);
  } else {
    await pipe.png({ compressionLevel: 6, adaptiveFiltering: true }).toFile(destFile);
  }
  return { file: destFile, rect };
}

/** 按裁剪范围重编码视频（用于生成新的裁剪实况；H.264/AAC + faststart，可直接播放） */
async function cropVideoToFile(absVideo, destFile, crop, options = {}) {
  await ensureDir(path.dirname(destFile));
  const probe = await probeVideo(absVideo);
  if (!probe.ok) throw new Error('视频无法解码');
  const filters = [cropFilter(crop)];
  if (options.maxWidth) filters.push(`scale='trunc(min(${options.maxWidth},iw)/2)*2':-2`);
  const r = await runFfmpeg([
    '-i', absVideo,
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', filters.join(','),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(options.crf ?? 18), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', destFile,
  ], 300000);
  if (r.code !== 0 || !(await exists(destFile))) {
    throw new Error(`视频裁剪失败：${(r.stderr || '').trim() || '未知错误'}`);
  }
  const out = await probeVideo(destFile);
  return { file: destFile, width: out.width || 0, height: out.height || 0, duration: out.duration || 0 };
}

/**
 * 把裁剪后的视频内嵌到裁剪后的 JPEG 尾部，生成单文件实况照片（Google Motion Photo 结构）。
 * 外部文件管理器/预览工具可直接从该 JPEG 读取并播放裁剪后的动态内容。
 */
async function embedMotionPhoto(stillFile, motionFile, outFile) {
  const still = await fsp.readFile(stillFile);
  if (still.length < 2 || still[0] !== 0xFF || still[1] !== 0xD8) {
    throw new Error('裁剪结果不是有效的 JPEG');
  }
  const motionStat = await fsp.stat(motionFile);
  if (!motionStat.size) throw new Error('裁剪后的实况视频为空');

  const xmp = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"
    GCamera:MotionPhoto="1"
    GCamera:MotionPhotoVersion="1"
    GCamera:MotionPhotoPresentationTimestampUs="0"
    GCamera:MicroVideo="1"
    GCamera:MicroVideoVersion="1"
    GCamera:MicroVideoOffset="${motionStat.size}"
    GCamera:MicroVideoPresentationTimestampUs="0"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const payload = Buffer.from(`http://ns.adobe.com/xap/1.0/\0${xmp}`, 'utf8');
  if (payload.length + 2 > 0xFFFF) throw new Error('XMP 数据过大');
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xFFE1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  const head = Buffer.concat([still.subarray(0, 2), app1, payload, still.subarray(2)]);

  await ensureDir(path.dirname(outFile));
  await fsp.writeFile(outFile, head);
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(motionFile);
    const ws = fs.createWriteStream(outFile, { flags: 'a' });
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
  return { file: outFile, motionBytes: motionStat.size };
}

/** 导出裁剪副本：像素精确裁剪，PNG 无损落盘，原件保持不变 */
async function exportCrop(absFile, meta, crop, destFile) {
  await ensureDir(path.dirname(destFile));
  const { image, width, height } = await orientedImage(absFile, meta);
  const rect = pixelRect(crop, width, height);
  await image.extract(rect).png({ compressionLevel: 6 }).toFile(destFile);
  return { file: destFile, rect };
}

module.exports = {
  readMeta, readVideoMeta, buildThumb, buildFullPng, buildCover,
  ensurePlayable, exportCrop, pixelRect, heicSize, isHeic,
  cropFilter, cropImageToFile, cropVideoToFile, embedMotionPhoto,
  pHash, hammingHex,
};
