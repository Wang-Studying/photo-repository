'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { Config } = require('./lib/config');
const { Library } = require('./lib/library');
const { MediaServer } = require('./lib/server');
const { detectPhone, listPhoneMedia, copyPhoneFiles, thumbPhoneFiles } = require('./lib/phone-device');
const { PhoneServer, PORT_RANGE, FIREWALL_RULE } = require('./lib/phone-server');
const QRCode = require('qrcode');
const media = require('./lib/media');
const { formatBytes, stemOf } = require('./lib/util');

let win = null;
let config = null;
let library = null;
let mediaServer = null;
let watchTimer = null;
let storageAvailable = true;
let phoneServer = null;

const APP_TITLE = '照片仓库';

function createWindow() {
  const bounds = config.all.window || {};
  win = new BrowserWindow({
    width: bounds.width || 1440,
    height: bounds.height || 920,
    x: bounds.x ?? undefined,
    y: bounds.y ?? undefined,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0b0d12',
    title: APP_TITLE,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  win.once('ready-to-show', () => {
    if (bounds.maximized) win.maximize();
    win.show();
  });
  win.on('close', () => {
    try {
      const b = win.getBounds();
      config.updateSync({
        window: {
          width: b.width, height: b.height, x: b.x, y: b.y,
          maximized: win.isMaximized(),
        },
      });
    } catch {}
  });
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function buildState() {
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    hasLibrary: Boolean(library),
    root: library ? library.root : (config.all.storageRoot || null),
    available: library ? library.isAvailable : false,
    missingRoot: !library && Boolean(config.all.storageRoot),
    expectedLibraryId: config.all.libraryId || null,
    library: library ? library.publicState() : null,
    statsText: library ? formatBytes(library.publicState().stats.bytes) : '',
    media: library ? { base: mediaServer.baseUrl(), token: mediaServer.token } : null,
    ui: config.all.ui,
  };
}

async function openAt(root) {
  const lib = await new Library(root).open();
  library = lib;
  mediaServer.setLibrary(lib);
  storageAvailable = lib.isAvailable;
  await config.update({ storageRoot: lib.root, libraryId: lib.index.libraryId });
  startStorageWatch();
  autoCleanTrash().catch(() => {});
  return buildState();
}

/** 按配置自动清理回收站：彻底删除超过 N 天的内容（N=0 表示关闭） */
async function autoCleanTrash() {
  const days = Number(config.all.ui && config.all.ui.trashAutoCleanDays) || 0;
  if (!days || !library) return;
  const cutoff = Date.now() - days * 86400000;
  const ids = library.index.items
    .filter((i) => i.deletedAt && new Date(i.deletedAt).getTime() < cutoff)
    .map((i) => i.id);
  if (!ids.length) return;
  try {
    await library.purgeItems(ids);
    send('library-changed', buildState());
    console.log(`回收站自动清理：已彻底删除 ${ids.length} 项（超过 ${days} 天）`);
  } catch (e) {
    console.warn('回收站自动清理失败：', e.message);
  }
}

function startStorageWatch() {
  clearInterval(watchTimer);
  watchTimer = setInterval(() => {
    if (!library) return;
    const available = library.isAvailable;
    if (available !== storageAvailable) {
      storageAvailable = available;
      send('storage-state', {
        available,
        root: library.root,
        message: available ? '存储介质已恢复，写入功能已启用' : '存储位置不可用，已切换为只读模式',
      });
    }
  }, 3000);
}

function requireLibrary() {
  if (!library) {
    const e = new Error('尚未打开照片仓库');
    e.code = 'NO_LIBRARY';
    throw e;
  }
  library.assertAvailable();
  return library;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await fn(...args);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e), code: (e && e.code) || 'ERROR' };
    }
  });
}

async function chooseRoot() {
  const result = await dialog.showOpenDialog(win, {
    title: '选择照片仓库存储位置（可选 U 盘等可移动介质）',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '使用此文件夹',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
}

/** 断连/盘符变化时按 libraryId 在已挂载磁盘中寻找库 */
async function locateLibrary(libraryId) {
  const drives = [];
  for (let c = 67; c <= 90; c += 1) {
    const drive = `${String.fromCharCode(c)}:\\`;
    try { await fsp.access(drive); drives.push(drive); } catch {}
  }
  const timeLimit = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
  const candidates = [];

  for (const drive of drives) {
    candidates.push(drive);
  }
  for (const drive of drives) {
    try {
      const entries = await timeLimit(fsp.readdir(drive, { withFileTypes: true }), 1500);
      if (!entries) continue;
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('$')) continue;
        candidates.push(path.join(drive, ent.name));
      }
    } catch {}
  }
  for (const base of candidates) {
    try {
      const idx = path.join(base, '.photo-repo', 'library.json');
      const raw = JSON.parse(await timeLimit(fsp.readFile(idx, 'utf8'), 800) || 'null');
      if (raw && (!libraryId || raw.libraryId === libraryId)) {
        const lib = await new Library(base).open();
        await lib.flush();
        if (libraryId && lib.index.libraryId !== libraryId) continue;
        return base;
      }
    } catch {}
  }
  return null;
}

// 手机相册封面任务：按目录轮询已生成的封面，生成一张就推送一张
let thumbToken = 0;

/**
 * Shell 缩略图拿不到时的本地兜底：把待生成封面的图片先复制到本地，
 * 再用项目既有的 media 能力生成封面（图片走 buildThumb，视频走 buildCover）。
 */
async function localThumbFallback(pending, dir, token, sent) {
  const srcDir = path.join(dir, 'src');
  await fsp.mkdir(srcDir, { recursive: true });
  const BATCH = 8;
  // 兜底需要先把文件复制到本机，限制单个视频与总量，避免为了封面传输过多数据
  const MAX_VIDEO = 150 * 1024 * 1024;
  const MAX_TOTAL = 400 * 1024 * 1024;
  let budget = MAX_TOTAL;
  const queue = pending.filter((p) => {
    const size = Number(p.size) || 0;
    if (p.kind === 'video' && size > MAX_VIDEO) return false;
    if (p.kind === 'video') {
      if (size > budget) return false;
      budget -= size;
    }
    return true;
  });
  for (let i = 0; i < queue.length; i += BATCH) {
    if (token !== thumbToken) return;
    const batch = queue.slice(i, i + BATCH);
    let copy;
    try {
      copy = await copyPhoneFiles(batch.map((p) => p.rel), srcDir);
    } catch { return; }
    if (!copy.copied.length) return; // 复制不可用，兜底也无法进行
    for (const p of batch) {
      if (token !== thumbToken) return;
      const src = path.join(srcDir, ...p.rel.split('/'));
      // 复制可能产生 0 字节/半截文件（设备把大小报成 0 时 Wait-Copy 会误判完成），先校验再解码
      let srcOk = false;
      try { srcOk = fs.statSync(src).size > 0; } catch {}
      if (!srcOk) { console.warn('[phone-thumb] 兜底复制缺失或为空:', p.rel, copy.failed || []); continue; }
      const out = path.join(dir, p.out);
      try {
        if (p.kind === 'video') {
          await media.buildCover(src, out, 480);
        } else {
          const meta = await media.readMeta(src);
          await media.buildThumb(src, meta, out, 480, null);
        }
      } catch (e) {
        console.warn('[phone-thumb] 本地封面生成失败:', p.rel, e && e.message);
      }
      let outOk = false;
      try { outOk = fs.statSync(out).size > 0; } catch {}
      if (outOk) {
        sent.add(p.out);
        send('phone-thumb', { id: p.id, url: mediaServer.previewUrl(p.out) });
      }
    }
    await fsp.rm(srcDir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(srcDir, { recursive: true });
  }
  await fsp.rm(srcDir, { recursive: true, force: true }).catch(() => {});
}

async function startThumbJob(groups, token) {
  const list = (Array.isArray(groups) ? groups : [])
    .filter((g) => g && typeof g.id === 'string' && Array.isArray(g.files) && g.files.length);
  if (!list.length) return;

  const baseDir = path.join(app.getPath('userData'), 'phone-thumbs');
  await fsp.rm(baseDir, { recursive: true, force: true });
  const dir = path.join(baseDir, String(token));
  await fsp.mkdir(dir, { recursive: true });
  mediaServer.setPreviewDir(dir);

  const plan = [];
  for (const g of list) {
    const rel = String(g.files[0] || '');
    if (!rel) continue;
    const out = `${crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16)}.jpg`;
    plan.push({ rel, out, id: g.id, kind: g.kind, size: Number(g.size) || 0 });
  }
  if (!plan.length) return;

  const sent = new Set();
  const scan = () => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (sent.has(name) || !/^[a-z0-9]+\.jpg$/.test(name)) continue;
      const hit = plan.find((p) => p.out === name);
      if (!hit) continue;
      sent.add(name);
      send('phone-thumb', { id: hit.id, url: mediaServer.previewUrl(name) });
    }
  };

  const timer = setInterval(() => {
    if (token !== thumbToken) return;
    scan();
  }, 500);
  try {
    const res = await thumbPhoneFiles(plan, dir, 480);
    if (token !== thumbToken) return;
    scan();
    const pending = plan.filter((p) => !sent.has(p.out));
    if (pending.length) {
      send('phone-thumb-status', { stage: 'local', total: plan.length, thumbs: sent.size });
      await localThumbFallback(pending, dir, token, sent);
    }
    if (token === thumbToken) {
      scan();
      send('phone-thumb-done', { total: plan.length, thumbs: sent.size, error: res.error || '' });
    }
  } finally {
    clearInterval(timer);
  }
}

function registerIpc() {
  handle('app:state', async () => buildState());

  handle('app:pick-root', async () => {
    const root = await chooseRoot();
    if (!root) return null;
    return openAt(root);
  });

  handle('app:use-root', async (root) => {
    if (!root) throw new Error('无效的目录');
    return openAt(root);
  });

  handle('app:locate-root', async () => {
    const found = await locateLibrary(config.all.libraryId || null);
    if (!found) return { found: false };
    const state = await openAt(found);
    return { found: true, state };
  });

  handle('app:open-root', async () => {
    const lib = requireLibrary();
    await shell.openPath(lib.root);
    return true;
  });

  handle('app:reveal-item', async (id) => {
    const lib = requireLibrary();
    const item = lib.findById(id);
    if (!item) throw new Error('条目不存在');
    const primary = item.stillRel || item.videoRel;
    if (!primary) throw new Error('文件路径缺失');
    shell.showItemInFolder(lib.abs(primary));
    return true;
  });

  handle('app:open-external', async (url) => {
    if (typeof url !== 'string' || !/^(https?:\/\/|ms-windows-store:\/\/)/i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  handle('app:set-ui', async (patch) => {
    await config.update({ ui: { ...config.all.ui, ...(patch || {}) } });
    return config.all.ui;
  });

  handle('library:import-dialog', async (mode) => {
    const options = mode === 'folder'
      ? { title: '选择要导入的文件夹', properties: ['openDirectory'] }
      : { title: '选择要导入的照片/视频（可多选）', properties: ['openFile', 'multiSelections'] };
    const result = await dialog.showOpenDialog(win, {
      ...options,
      filters: mode === 'folder' ? undefined
        : [{ name: '媒体文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'dng', 'cr2', 'nef', 'arw', 'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths;
  });

  handle('library:import-paths', async (paths) => {
    const lib = requireLibrary();
    const summary = await lib.importPaths(paths, (progress) => send('import-progress', progress));
    lib.reindexMaps();
    send('library-changed', buildState());
    return summary;
  });

  handle('library:rescan', async () => {
    const lib = requireLibrary();
    const result = await lib.rescan((progress) => send('rescan-progress', progress));
    send('library-changed', buildState());
    return result;
  });

  handle('library:update-item', async (id, patch) => {
    const lib = requireLibrary();
    const item = await lib.updateItem(id, patch);
    send('library-changed', buildState());
    return item;
  });

  // 懒回填早期条目的 EXIF（镜头/光圈/快门/ISO/焦距），打开查看器时按需触发
  handle('library:item-exif', async (id) => {
    const lib = requireLibrary();
    const item = lib.index.items.find((i) => i.id === id);
    if (!item || !item.stillRel) return null;
    try {
      const meta = await media.readMeta(lib.abs(item.stillRel));
      const patch = {};
      if (meta.lens && !item.lens) patch.lens = meta.lens;
      if (meta.exposure && !item.exposure) patch.exposure = meta.exposure;
      if (Object.keys(patch).length) await lib.updateItem(id, patch);
      return { id, lens: item.lens || patch.lens || '', exposure: item.exposure || patch.exposure || null };
    } catch { return null; }
  });

  handle('library:delete-items', async (ids) => {
    const lib = requireLibrary();
    const result = await lib.deleteItems(ids);
    send('library-changed', buildState());
    return result;
  });

  handle('library:restore-items', async (ids) => {
    const lib = requireLibrary();
    const result = await lib.restoreItems(ids);
    send('library-changed', buildState());
    return result;
  });

  handle('library:purge-items', async (ids) => {
    const lib = requireLibrary();
    const result = await lib.purgeItems(ids);
    send('library-changed', buildState());
    return result;
  });

  handle('library:export-items', async (ids) => {
    const lib = requireLibrary();
    const result = await dialog.showOpenDialog(win, { title: '选择导出位置', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    const dir = result.filePaths[0];
    const usedNames = new Set();
    const uniq = (name) => {
      const ext = path.extname(name);
      const stem = path.basename(name, ext);
      let cand = name;
      let i = 1;
      while (usedNames.has(cand.toLowerCase()) || fs.existsSync(path.join(dir, cand))) {
        cand = `${stem}-${i}${ext}`;
        i += 1;
      }
      usedNames.add(cand.toLowerCase());
      return cand;
    };
    let count = 0;
    for (const id of ids || []) {
      const item = lib.index.items.find((i) => i.id === id);
      if (!item || item.deletedAt) continue;
      // 实况照片同时导出静态图和视频段，均保持原始字节
      for (const rel of [item.stillRel, item.motionRel]) {
        if (!rel) continue;
        try {
          await fsp.copyFile(lib.abs(rel), path.join(dir, uniq(path.basename(rel))));
          count += 1;
        } catch {}
      }
    }
    if (count) shell.openPath(dir).catch(() => {});
    return { count, dir };
  });

  handle('library:empty-trash', async () => {
    const lib = requireLibrary();
    const result = await lib.emptyTrash();
    send('library-changed', buildState());
    return result;
  });

  handle('library:create-album', async (name) => {
    const lib = requireLibrary();
    const album = await lib.createAlbum(name);
    send('library-changed', buildState());
    return album;
  });

  handle('library:rename-album', async (id, name) => {
    const lib = requireLibrary();
    const album = await lib.renameAlbum(id, name);
    send('library-changed', buildState());
    return album;
  });

  handle('library:delete-album', async (id) => {
    const lib = requireLibrary();
    await lib.deleteAlbum(id);
    send('library-changed', buildState());
    return true;
  });

  handle('library:add-to-album', async (ids, albumId) => {
    const lib = requireLibrary();
    await lib.addToAlbum(ids, albumId);
    send('library-changed', buildState());
    return true;
  });

  handle('library:remove-from-album', async (ids, albumId) => {
    const lib = requireLibrary();
    await lib.removeFromAlbum(ids, albumId);
    send('library-changed', buildState());
    return true;
  });

  handle('library:save-crop', async (id, crop) => {
    const lib = requireLibrary();
    const item = await lib.saveCrop(id, crop);
    send('library-changed', buildState());
    return item;
  });

  handle('library:export-crop', async (id, crop) => {
    const lib = requireLibrary();
    const item = lib.findById(id);
    if (!item) throw new Error('条目不存在');
    const base = stemOf(item.name);
    const result = await dialog.showSaveDialog(win, {
      title: '导出裁剪副本（PNG 无损）',
      defaultPath: `${base}-crop.png`,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const exported = await lib.exportCrop(id, result.filePath, crop);
    return { file: exported.file, rect: exported.rect };
  });

  handle('library:verify-item', async (id) => {
    const lib = requireLibrary();
    return lib.verifyItem(id);
  });

  handle('library:clear-cache', async () => {
    const lib = requireLibrary();
    await lib.clearCache();
    return true;
  });

  handle('library:migrate', async () => {
    const lib = requireLibrary();
    const target = await dialog.showOpenDialog(win, {
      title: '选择新的存储位置（迁移后原库会保留）',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '迁移到此处',
    });
    if (target.canceled || !target.filePaths[0]) return null;
    const newRoot = target.filePaths[0];
    const result = await lib.migrateTo(newRoot, (progress) => send('migrate-progress', progress));
    await openAt(result.root);
    send('library-changed', buildState());
    return { ok: true, root: result.root, files: result.files };
  });

  handle('library:stats', async () => {
    const lib = requireLibrary();
    return lib.publicState().stats;
  });

  // ---------- 相似照片扫描（dHash 汉明距离分组，结果交前端挑选） ----------
  handle('library:find-similar', async () => {
    const lib = requireLibrary();
    const items = lib.index.items.filter((i) => !i.deletedAt && i.stillRel);
    const cacheFile = path.join(lib.cacheDir, 'phash.json');
    let cache = {};
    try { cache = JSON.parse(await fsp.readFile(cacheFile, 'utf8')); } catch {}
    const next = {};
    const todo = [];
    for (const it of items) {
      const c = cache[it.id];
      if (c && c.hash === it.hash && c.ph) next[it.id] = c;
      else todo.push(it);
    }
    let done = 0;
    const total = todo.length;
    // 小并发计算，避免解码打满 CPU
    const workers = Array.from({ length: 4 }, async () => {
      for (;;) {
        const it = todo.shift();
        if (!it) return;
        try {
          const ph = await media.pHash(lib.abs(it.stillRel));
          next[it.id] = { hash: it.hash, ph };
        } catch {}
        done += 1;
        if (done % 5 === 0 || done === total) send('similar-progress', { done, total });
      }
    });
    await Promise.all(workers);
    try { await fsp.writeFile(cacheFile, JSON.stringify(next), 'utf8'); } catch {}

    // 并查集：汉明距离 ≤ 6 归为一组
    const withHash = items.filter((i) => next[i.id]);
    const parent = new Map(withHash.map((i) => [i.id, i.id]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (let a = 0; a < withHash.length; a++) {
      for (let b = a + 1; b < withHash.length; b++) {
        if (find(withHash[a].id) === find(withHash[b].id)) continue;
        if (media.hammingHex(next[withHash[a].id].ph, next[withHash[b].id].ph) <= 6) {
          parent.set(find(withHash[a].id), find(withHash[b].id));
        }
      }
    }
    const groups = new Map();
    for (const it of withHash) {
      const root = find(it.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(it.id);
    }
    const result = [...groups.values()]
      .filter((g) => g.length >= 2)
      .map((ids) => ids.sort((x, y) => {
        const ix = withHash.find((i) => i.id === x);
        const iy = withHash.find((i) => i.id === y);
        return (ix.takenAt || 0) - (iy.takenAt || 0);
      }))
      .sort((a, b) => b.length - a.length);
    return { groups: result, scanned: withHash.length, computed: total };
  });

  // ---------- 手机传输（有线：检测设备 → 选择相册文件 → 直接导入） ----------
  handle('phone:detect', async () => detectPhone());

  // ---------- 手机传输（WiFi：扫码网页上传，收一个入一个） ----------
  handle('phone-wifi:start', async (ip) => {
    const lib = requireLibrary();
    if (!phoneServer) phoneServer = new PhoneServer();
    const staging = path.join(app.getPath('userData'), 'wifi-upload');
    const info = await phoneServer.start({
      stagingDir: staging,
      ip: ip || null,
      onProgress: (p) => send('phone-wifi-progress', p),
      onFile: async (absPath, name) => {
        const summary = await lib.importPaths([absPath], () => {});
        if (summary.added > 0) {
          send('library-changed', buildState());
          return 'imported';
        }
        if (summary.skipped > 0) return 'dup';
        const reason = summary.failed[0] && summary.failed[0].reason;
        throw new Error(reason || `未识别为可导入的媒体文件（${name}）`);
      },
    });
    const urls = [];
    for (const c of info.urls || []) {
      let qr = null;
      try {
        qr = await QRCode.toDataURL(c.url, { margin: 1, width: 220, color: { dark: '#e8ebf2', light: '#161b26' } });
      } catch {}
      urls.push({ ...c, qr });
    }
    return {
      ok: true,
      url: info.url,
      port: info.port,
      qr: urls.length ? urls[0].qr : null,
      urls,
    };
  });

  handle('phone-wifi:stop', async () => {
    if (phoneServer) await phoneServer.stop();
    return { ok: true };
  });

  // 手机打不开页面时最常见的原因是 Windows 防火墙丢弃入站连接（表现就是浏览器一直转圈）
  handle('phone-wifi:allow-firewall', async () => {
    const range = `${PORT_RANGE.start}-${PORT_RANGE.end}`;
    const exists = await new Promise((resolve) => {
      execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE}`], (err, stdout) => {
        resolve(!err && /LocalPort/i.test(String(stdout || '')));
      });
    });
    if (exists) return { existed: true };
    const args = [
      'advfirewall', 'firewall', 'add', 'rule',
      `name=${FIREWALL_RULE}`, 'dir=in', 'action=allow', 'protocol=TCP',
      `localport=${range}`, 'enable=yes', 'profile=any',
    ];
    const script = `Start-Process -FilePath 'netsh.exe' -ArgumentList @(${args.map((a) => `'${a}'`).join(',')}) -Verb RunAs -Wait -WindowStyle Hidden`;
    const res = await new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
        resolve({ err, stdout, stderr });
      });
    });
    if (res.err) {
      throw new Error('未能添加防火墙规则（可能是 UAC 授权被取消），请手动允许「照片仓库」通过 Windows 防火墙');
    }
    return { existed: false, range };
  });

  handle('phone:list', async () => {
    const res = await listPhoneMedia();
    // 用「文件名 + 大小」与库内已有条目比对，标记可能已导入的项（MTP 上逐文件算 hash 太慢，这里做轻量提示）
    try {
      if (library && Array.isArray(res.groups) && res.groups.length) {
        const seen = new Set();
        for (const it of library.index.items) {
          if (it.deletedAt || !it.name) continue;
          seen.add(`${String(it.name).toLowerCase()}|${Number(it.size) || 0}`);
        }
        for (const g of res.groups) {
          const entries = Array.isArray(g.entries) ? g.entries : (g.entries ? [g.entries] : []);
          const primary = entries[0];
          if (primary && seen.has(`${String(primary.name).toLowerCase()}|${Number(primary.size) || 0}`)) {
            g.imported = true;
          }
        }
      }
    } catch {}
    return res;
  });

  handle('phone:thumbs', async (groups) => {
    thumbToken += 1;
    const token = thumbToken;
    startThumbJob(groups, token).catch(() => {});
    return { started: true };
  });

  handle('phone:import', async (rels) => {
    if (!Array.isArray(rels) || !rels.length) {
      const e = new Error('未选择任何文件');
      e.code = 'EMPTY_SELECTION';
      throw e;
    }
    const lib = requireLibrary();
    let staging = path.join(app.getPath('userData'), 'phone-cache');
    try {
      await fsp.rm(staging, { recursive: true, force: true });
    } catch {
      // 上次暂存里若有被占用的文件（旧版本解码句柄未释放）会删不掉，换全新目录，不阻塞导入
      staging = path.join(app.getPath('userData'), `phone-cache-${Date.now()}`);
    }
    await fsp.mkdir(staging, { recursive: true });
    try {
      const copy = await copyPhoneFiles(rels, staging);
      if (!copy.copied.length) {
        const code = copy.error || 'COPY_FAILED';
        let msg = copy.error || '';
        if (code === 'NO_DEVICE') msg = '手机已断开连接，请重新连接后点击「重新检测」';
        else if (code === 'COPY_BLOCKED') msg = '无法从手机读取文件，请在手机上解锁屏幕并允许访问照片后重试';
        else if (code === 'TIMEOUT') msg = '复制超时，请检查手机连接后重试';
        if (!msg) {
          const first = copy.failed[0];
          msg = first && first.error === 'NOT_FOUND'
            ? '手机上未找到所选文件，请点击「重新检测」刷新列表'
            : '未能从手机复制任何文件，请重试';
        }
        const e = new Error(msg);
        e.code = code;
        throw e;
      }
      const summary = await lib.importPaths([staging], (p) => send('import-progress', p));
      await lib.flush();
      lib.reindexMaps();
      send('library-changed', buildState());
      if (!summary.added && !summary.skipped) {
        const e = new Error('文件已复制到本机但入库失败，请重试');
        e.code = 'IMPORT_FAILED';
        throw e;
      }
      return { summary, copy };
    } finally {
      fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  });
}

async function bootstrap() {
  config = new Config(app.getPath('userData'));
  mediaServer = await new MediaServer().start();
  registerIpc();

  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);
  createWindow();

  const savedRoot = config.all.storageRoot;
  if (savedRoot && fs.existsSync(savedRoot)) {
    try {
      await openAt(savedRoot);
      send('library-changed', buildState());
    } catch (e) {
      console.error('打开已保存的库失败：', e);
    }
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((e) => {
    console.error(e);
    dialog.showErrorBox('启动失败', String(e && e.message ? e.message : e));
    app.quit();
  });

  app.on('window-all-closed', () => {
    clearInterval(watchTimer);
    if (phoneServer) phoneServer.stop().catch(() => {});
    if (mediaServer) mediaServer.stop();
    app.quit();
  });

  app.on('before-quit', async () => {
    try { if (library) await library.flush(); } catch {}
  });
}
