'use strict';

/**
 * 应用数据目录定位（必须在 app ready 之前调用）。
 *
 * 目标：不再使用系统盘的 %APPDATA%\照片仓库，而是放到用户自定义的位置——
 * 安装向导里选定的安装目录（便携版为其 exe 所在目录）下的 photo-repo-data。
 * Chromium 的 cookies / Cache 默认落在 userData 里，必须在 ready 前 setPath，
 * 否则会先在旧位置创建目录。
 *
 * 解析顺序：
 *   1. 安装目录里的指针文件 photo-repo-location.json（记录实际使用的数据目录）
 *   2. 安装目录下的 photo-repo-data
 *   3. 库根目录下的 .photo-repo/app-data（安装目录只读时，如装在 Program Files）
 *   4. 系统默认位置（兜底：可用但无法满足“不写系统盘”，保留旧目录不删）
 */
const fs = require('fs');
const path = require('path');

const POINTER_NAME = 'photo-repo-location.json';
const DATA_DIR_NAME = 'photo-repo-data';

/** 用户自定义的宿主目录：便携版取 exe 所在目录，开发时取项目根，正常安装取安装目录 */
function hostDir(app) {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portable) return path.resolve(portable);
  if (app && app.isPackaged === false) return app.getAppPath();
  return path.dirname(process.execPath);
}

function pointerPath(host) {
  return path.join(host, POINTER_NAME);
}

/** 读取指针文件里的数据目录（不存在或损坏时返回 null） */
function readPointer(host) {
  try {
    const raw = JSON.parse(fs.readFileSync(pointerPath(host), 'utf8'));
    if (raw && typeof raw.dataDir === 'string' && raw.dataDir.trim()) return path.resolve(raw.dataDir);
  } catch {}
  return null;
}

function writePointer(host, dataDir) {
  try {
    fs.mkdirSync(host, { recursive: true });
    fs.writeFileSync(pointerPath(host), JSON.stringify({ version: 1, dataDir }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 目录是否可用：能创建、能写入、能删除探测文件 */
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** 从旧版配置里读出照片库根目录 */
function readStorageRoot(configFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const root = raw && raw.storageRoot;
    return typeof root === 'string' && root.trim() ? root : null;
  } catch {
    return null;
  }
}

/**
 * 决定数据目录并把 userData / sessionData / crashDumps 全部重定向。
 * 返回的信息供启动流程做旧目录迁移与日志输出。
 */
function prepare(app) {
  const host = hostDir(app);
  // 此时尚未 setPath，取到的就是系统默认位置（%APPDATA%\照片仓库）
  const legacyDir = app.getPath('userData');
  const legacyRoot = readStorageRoot(path.join(legacyDir, 'config.json'));

  const remembered = readPointer(host);
  let dataDir = null;
  let fallback = null;

  if (remembered && isWritableDir(remembered)) {
    dataDir = remembered;
  } else if (isWritableDir(path.join(host, DATA_DIR_NAME))) {
    dataDir = path.join(host, DATA_DIR_NAME);
  } else if (legacyRoot) {
    const besideLibrary = path.join(legacyRoot, '.photo-repo', 'app-data');
    if (isWritableDir(besideLibrary)) {
      dataDir = besideLibrary;
      fallback = 'library';
    }
  }
  if (!dataDir) {
    dataDir = legacyDir;
    fallback = 'system';
  }

  const moved = path.resolve(dataDir) !== path.resolve(legacyDir);
  if (moved) {
    app.setPath('userData', dataDir);
    app.setPath('sessionData', dataDir);
    app.setPath('crashDumps', path.join(dataDir, 'Crashpad'));
  }
  if (!fallback) writePointer(host, dataDir);

  return {
    dataDir,
    host,
    legacyDir,
    legacyRoot,
    fallback,
    pointer: pointerPath(host),
    moved,
  };
}

/**
 * 把旧数据目录里的配置搬到新目录，确认新配置存在后才删除旧目录。
 * 旧目录里的 Cache / phone-thumbs 等都是可再生缓存，随目录一起清理。
 * 返回 { migrated, removed, kept }，kept 表示因迁移失败而保留旧目录。
 */
async function migrateLegacyData(legacyDir, dataDir) {
  if (path.resolve(legacyDir) === path.resolve(dataDir)) {
    return { migrated: false, removed: false, kept: false };
  }
  const srcConfig = path.join(legacyDir, 'config.json');
  const dstConfig = path.join(dataDir, 'config.json');
  let migrated = false;
  if (fs.existsSync(srcConfig) && !fs.existsSync(dstConfig)) {
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.copyFile(srcConfig, dstConfig);
    migrated = true;
  }
  if (fs.existsSync(srcConfig) && !fs.existsSync(dstConfig)) {
    return { migrated, removed: false, kept: true };
  }
  await fs.promises.rm(legacyDir, { recursive: true, force: true });
  return { migrated, removed: !fs.existsSync(legacyDir), kept: false };
}

module.exports = {
  prepare,
  hostDir,
  pointerPath,
  readPointer,
  writePointer,
  isWritableDir,
  readStorageRoot,
  migrateLegacyData,
  POINTER_NAME,
  DATA_DIR_NAME,
};
