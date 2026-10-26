(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const api = window.api;

  const PAD = 26;
  const GAP = 10;

  const S = {
    app: null,
    items: [],
    itemMap: new Map(),
    albums: [],
    tags: [],
    media: null,
    view: { type: 'timeline', albumId: null, tag: null },
    mediaFilter: 'all',
    search: '',
    filtered: [],
    selection: new Set(),
    lastIndex: -1,
    tileSize: 210,
    layout: { blocks: [], total: 0, tile: 210, cols: 5 },
    viewer: { open: false, list: [], index: 0, currentId: null },
    crop: null,
    hover: { timer: null, tile: null, item: null, gen: 0 },
    storageOk: true,
    scrollTick: 0,
  };

  const tileCache = new Map();
  const $viewport = () => $('#viewport');
  const $content = () => $('#content');

  // ---------------- 小工具 ----------------
  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
  }

  function fmtDuration(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function dayKey(ts) {
    const d = new Date(ts || Date.now());
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function dayLabel(ts) {
    const d = new Date(ts || Date.now());
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (dayKey(ts) === dayKey(today.getTime())) return '今天';
    if (dayKey(ts) === dayKey(yesterday.getTime())) return '昨天';
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    const sameYear = d.getFullYear() === today.getFullYear();
    return sameYear
      ? `${d.getMonth() + 1}月${d.getDate()}日 星期${week}`
      : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(message, kind = '', action) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    const txt = document.createElement('span');
    txt.textContent = message;
    el.appendChild(txt);
    if (action && action.label && action.onClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        action.onClick();
        el.remove();
      });
      el.appendChild(btn);
    }
    $('#toasts').appendChild(el);
    const remove = () => {
      el.style.transition = 'opacity .2s, transform .2s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 220);
    };
    const timer = setTimeout(remove, action ? 8000 : 2600);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => setTimeout(remove, 2600));
  }

  function mediaUrl(kind, item, opts = {}) {
    if (!S.media || !item) return '';
    const q = new URLSearchParams();
    if (opts.size) q.set('s', String(opts.size));
    q.set('v', String(item.updatedAt || 0));
    if (opts.crop === false) q.set('crop', '0');
    return `${S.media.base}/m/${S.media.token}/${kind}/${encodeURIComponent(item.id)}?${q.toString()}`;
  }

  function setBanner(html, kind = '') {
    const el = $('#banner');
    if (!html) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.className = kind;
    el.innerHTML = html;
  }

  async function call(fn, ...args) {
    const res = await fn(...args);
    if (!res || !res.ok) {
      const msg = res?.error || '操作失败';
      toast(msg, 'error');
      if (res?.code === 'STORAGE_UNAVAILABLE') showStorageBanner(false);
      throw new Error(msg);
    }
    return res.data;
  }

  // ---------------- 状态应用 ----------------
  function applyState(data, opts = {}) {
    const prevRoot = S.app?.root;
    S.app = data;
    S.items = (data.library?.items || []).slice();
    S.itemMap = new Map(S.items.map((i) => [i.id, i]));
    S.albums = data.library?.albums || [];
    S.tags = data.library?.tags || [];
    S.media = data.media || null;
    S.storageOk = Boolean(data.available);

    if (data.ui && data.ui.tileSize) {
      S.tileSize = Number(data.ui.tileSize) || 210;
    }

    $('#storage-path').textContent = data.root ? shortRoot(data.root) : '未连接存储';
    $('#storage-path').title = data.root || '';
    $('#setting-root').textContent = data.root || '—';
    $('#setting-about').textContent = `照片仓库 v${data.appVersion || '1.0.0'} · 本地优先 · 不做云端上传`;

    if (!data.hasLibrary) {
      $('#onboarding').classList.remove('hidden');
      $('#main').classList.add('hidden');
      return;
    }
    $('#onboarding').classList.add('hidden');
    $('#main').classList.remove('hidden');

    if (prevRoot && prevRoot !== data.root) S.view = { type: 'timeline', albumId: null, tag: null };

    renderSidebar();
    renderView(true);
    updateStorageBanner();
    if (S.viewer.open) refreshViewer();
    if (!opts.silent) updateEmpty(S.filtered);
  }

  function shortRoot(root) {
    const parts = String(root).split(/[\\/]/).filter(Boolean);
    if (parts.length <= 2) return root;
    return `${parts[0]}${root.includes('/') ? '/' : '\\'}…\\${parts[parts.length - 1]}`;
  }

  function showStorageBanner(ok) {
    if (ok) { setBanner(''); return; }
    setBanner(
      '<span>存储位置不可用（可能已断开）。当前为只读模式，原文件不会被修改。</span>'
      + '<button id="banner-retry">重新检测</button><button id="banner-locate">查找库</button>',
      'error',
    );
    const retry = $('#banner-retry');
    if (retry) retry.onclick = async () => { await refreshState(); };
    const locate = $('#banner-locate');
    if (locate) locate.onclick = async () => {
      try {
        const r = await call(api.locateRoot);
        if (!r.found) { toast('未找到匹配的照片仓库，请手动选择存储位置', 'error'); return; }
        applyState(r.state);
        toast('已重新连接存储介质', 'success');
      } catch {}
    };
  }

  function updateStorageBanner() {
    if (!S.app) return;
    if (S.app.missingRoot) {
      setBanner(
        '<span>上次使用的存储位置已不可用。请重新选择该目录，或查找已有照片仓库。</span>'
        + '<button id="banner-pick">重新选择</button><button id="banner-locate">查找库</button>',
        'error',
      );
      $('#banner-pick').onclick = pickRoot;
      $('#banner-locate').onclick = locateRoot;
      return;
    }
    if (!S.storageOk) { showStorageBanner(false); return; }
    setBanner('');
  }

  async function refreshState() {
    try {
      const data = await call(api.state);
      applyState(data, { silent: true });
    } catch {}
  }

  let importRenderTimer = null;

  /** 导入过程中把新条目实时并入网格，避免等全部结束才出现 */
  function mergeImportedItem(item) {
    if (!item || !S.app?.hasLibrary || S.itemMap.has(item.id)) return;
    S.items.push(item);
    S.itemMap.set(item.id, item);
    const st = S.app.library?.stats;
    if (st) {
      st.total = (st.total || 0) + 1;
      st.bytes = (st.bytes || 0) + (item.size || 0);
      if (item.type === 'live') st.live = (st.live || 0) + 1;
    }
    if (importRenderTimer) return;
    importRenderTimer = setTimeout(() => {
      importRenderTimer = null;
      if (S.app?.hasLibrary) { renderSidebar(); renderView(true); }
    }, 220);
  }

  function renderImportProgress(p) {
    const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    const name = String(p.current || '').split(/[\\/]/).pop();
    const el = $('#banner');
    el.className = '';
    el.innerHTML = `<div class="import-progress">
      <div class="import-progress-head"><span>正在导入 ${p.done}/${p.total} · ${pct}%</span><span class="import-current">${esc(name)}</span></div>
      <div class="import-progress-track"><div class="import-progress-fill" style="width:${pct}%"></div></div>
      <div class="import-progress-sub">新增 ${p.added} · 跳过 ${p.skipped}</div>
    </div>`;
  }

  // ---------------- 侧栏 ----------------
  function renderSidebar() {
    const stats = S.app?.library?.stats || {};
    $('#count-all').textContent = stats.total || 0;
    $('#count-fav').textContent = stats.favorites || 0;
    $('#count-trash').textContent = stats.trash || 0;

    $$('#nav .nav-item').forEach((btn) => {
      const type = btn.dataset.nav;
      btn.classList.toggle('active', S.view.type === type);
    });

    const list = $('#album-list');
    list.innerHTML = '';
    if (!S.albums.length) {
      list.innerHTML = '<div class="album-empty">还没有相册</div>';
    }
    for (const album of S.albums) {
      const count = S.items.filter((i) => !i.deletedAt && (i.albumIds || []).includes(album.id)).length;
      const el = document.createElement('div');
      el.className = `album-item${S.view.type === 'album' && S.view.albumId === album.id ? ' active' : ''}`;
      el.innerHTML = `<span class="album-name">${esc(album.name)}</span><em>${count}</em>`;
      el.onclick = () => setView({ type: 'album', albumId: album.id });
      el.oncontextmenu = (e) => albumMenu(e, album);
      list.appendChild(el);
    }

    const cloud = $('#tag-list');
    cloud.innerHTML = '';
    if (!S.tags.length) cloud.innerHTML = '<div class="album-empty">还没有标签</div>';
    for (const t of S.tags.slice(0, 48)) {
      const btn = document.createElement('button');
      btn.className = `tag-chip${S.view.type === 'tag' && S.view.tag === t.name ? ' active' : ''}`;
      btn.textContent = `${t.name} ${t.count}`;
      btn.onclick = () => setView({ type: 'tag', tag: t.name });
      cloud.appendChild(btn);
    }
  }

  function albumMenu(e, album) {
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, [
      {
        label: '重命名相册',
        action: async () => {
          const name = await promptDialog('重命名相册', album.name);
          if (!name) return;
          try { await call(api.renameAlbum, album.id, name); toast('相册已重命名', 'success'); } catch {}
        },
      },
      {
        label: '删除相册',
        danger: true,
        action: async () => {
          const ok = await confirmDialog('删除相册', `确定删除相册「${album.name}」吗？照片本身不会被删除。`, '删除');
          if (!ok) return;
          try {
            await call(api.deleteAlbum, album.id);
            if (S.view.type === 'album' && S.view.albumId === album.id) setView({ type: 'timeline' });
            toast('相册已删除', 'success');
          } catch {}
        },
      },
    ]);
  }

  function setView(view) {
    S.view = view;
    S.selection.clear();
    S.lastIndex = -1;
    updateSelectionBar();
    renderSidebar();
    const vp = $viewport();
    if (vp) vp.scrollTop = 0;
    renderView();
  }

  // ---------------- 过滤 / 布局 ----------------
  function computeFiltered() {
    let list;
    if (S.view.type === 'trash') {
      list = S.items.filter((i) => i.deletedAt);
    } else {
      list = S.items.filter((i) => !i.deletedAt);
      if (S.view.type === 'favorites') list = list.filter((i) => i.favorite);
      else if (S.view.type === 'album') list = list.filter((i) => (i.albumIds || []).includes(S.view.albumId));
      else if (S.view.type === 'tag') list = list.filter((i) => (i.tags || []).includes(S.view.tag));
    }

    if (S.mediaFilter !== 'all') {
      if (S.mediaFilter === 'image') list = list.filter((i) => i.type === 'image');
      else if (S.mediaFilter === 'live') list = list.filter((i) => i.type === 'live');
      else if (S.mediaFilter === 'video') list = list.filter((i) => i.type === 'video');
    }

    const q = S.search.trim().toLowerCase();
    if (q) {
      const albumNames = new Map(S.albums.map((a) => [a.id, a.name.toLowerCase()]));
      list = list.filter((i) => {
        if ((i.name || '').toLowerCase().includes(q)) return true;
        if ((i.tags || []).some((t) => t.toLowerCase().includes(q))) return true;
        if ((i.albumIds || []).some((id) => (albumNames.get(id) || '').includes(q))) return true;
        return false;
      });
    }

    const sortKey = S.view.type === 'trash' ? (i) => i.deletedAt : (i) => i.takenAt;
    return list.sort((a, b) => sortKey(b) - sortKey(a));
  }

  function groupItems(list) {
    const groups = [];
    let current = null;
    for (const item of list) {
      const ts = S.view.type === 'trash' ? item.deletedAt : item.takenAt;
      const key = dayKey(ts);
      if (!current || current.key !== key) {
        current = { key, label: dayLabel(ts), items: [] };
        groups.push(current);
      }
      current.items.push(item);
    }
    return groups;
  }

  function updateViewTitle(list) {
    let title = '图库';
    if (S.view.type === 'favorites') title = '收藏';
    else if (S.view.type === 'trash') title = '回收站';
    else if (S.view.type === 'album') {
      const a = S.albums.find((x) => x.id === S.view.albumId);
      title = a ? a.name : '相册';
    } else if (S.view.type === 'tag') title = `# ${S.view.tag}`;

    $('#view-title').textContent = title;
    const parts = [`${list.length} 项`];
    if (S.view.type === 'timeline' && S.app?.library?.stats) {
      const st = S.app.library.stats;
      parts.push(`${st.live} 个实况`, fmtBytes(st.bytes));
    }
    if (S.view.type === 'trash') parts.push('删除后可在此还原');
    $('#view-sub').textContent = parts.join(' · ');
  }

  function buildLayout(list) {
    const vp = $viewport();
    const width = vp ? vp.clientWidth : 1000;
    const target = S.tileSize;
    const cols = Math.max(2, Math.floor((width - PAD * 2 + GAP) / (target + GAP)));
    const tile = Math.max(80, Math.floor((width - PAD * 2 - GAP * (cols - 1)) / cols));

    const blocks = [];
    const railEntries = [];
    let lastMonthKey = '';
    let y = 0;
    for (const group of groupItems(list)) {
      const ts0 = group.items[0] ? (S.view.type === 'trash' ? group.items[0].deletedAt : group.items[0].takenAt) : 0;
      const d0 = new Date(ts0 || Date.now());
      const mk = `${d0.getFullYear()}-${d0.getMonth() + 1}`;
      if (mk !== lastMonthKey) {
        lastMonthKey = mk;
        railEntries.push({ label: `${d0.getFullYear()}.${String(d0.getMonth() + 1).padStart(2, '0')}`, y });
      }
      blocks.push({
        type: 'header',
        label: group.label,
        count: group.items.length,
        ids: group.items.map((i) => i.id),
        y,
        h: 44,
      });
      y += 44;
      for (let i = 0; i < group.items.length; i += cols) {
        blocks.push({ type: 'row', items: group.items.slice(i, i + cols), y, h: tile });
        y += tile + GAP;
      }
      y += 12;
    }

    S.layout = { blocks, total: y, tile, cols };
    renderTimeRail(railEntries);
    const spacer = $('#spacer');
    spacer.style.height = `${Math.max(y + PAD * 2, (vp ? vp.clientHeight : 400))}px`;
  }

  /** 右侧时间线跳转条：按月份锚点，点击跳到对应分组 */
  function renderTimeRail(entries) {
    const rail = $('#time-rail');
    if (!entries || entries.length < 2) { rail.classList.add('hidden'); rail.innerHTML = ''; return; }
    rail.classList.remove('hidden');
    rail.innerHTML = '';
    for (const e of entries) {
      const b = document.createElement('button');
      b.className = 'tr-btn';
      b.textContent = e.label;
      b.title = `跳转到 ${e.label}`;
      b.onclick = () => { $viewport().scrollTop = Math.max(0, e.y - 8); };
      rail.appendChild(b);
    }
  }

  function renderView(keepScroll = false) {
    if (!S.app || !S.app.hasLibrary) return;
    const scrollTop = keepScroll ? $viewport().scrollTop : 0;
    S.filtered = computeFiltered();
    updateViewTitle(S.filtered);
    buildLayout(S.filtered);
    renderWindow();
    updateEmpty(S.filtered);
    if (!keepScroll) $viewport().scrollTop = 0;
    else $viewport().scrollTop = Math.min(scrollTop, Math.max(0, S.layout.total + PAD * 2 - $viewport().clientHeight));

    // 清理已不在列表中的选中项
    const valid = new Set(S.filtered.map((i) => i.id));
    let changed = false;
    for (const id of [...S.selection]) {
      if (!valid.has(id)) { S.selection.delete(id); changed = true; }
    }
    if (changed) updateSelectionBar();
  }

  function updateEmpty(list) {
    const empty = $('#empty');
    if (list.length) { empty.classList.add('hidden'); return; }
    empty.classList.remove('hidden');
    let title = '这里还没有内容';
    let sub = '拖动照片 / 视频到这里，或点击右上角「导入」';
    if (S.search.trim()) { title = '没有匹配的结果'; sub = '换个关键词试试'; }
    else if (S.view.type === 'favorites') { title = '还没有收藏'; sub = '打开照片后点击「收藏」'; }
    else if (S.view.type === 'trash') { title = '回收站是空的'; sub = '删除的照片会先放到这里'; }
    else if (S.view.type === 'album') { title = '相册是空的'; sub = '选择照片后右键「加入相册」'; }
    else if (S.view.type === 'tag') { title = '该标签下没有照片'; sub = '可在查看器中编辑标签'; }
    empty.querySelector('.empty-title').textContent = title;
    empty.querySelector('.empty-sub').textContent = sub;
  }

  // ---------------- 网格渲染（虚拟滚动） ----------------
  function renderWindow() {
    const vp = $viewport();
    const content = $content();
    const top = vp.scrollTop;
    const height = vp.clientHeight;
    const overscan = height;
    const from = Math.max(0, top - overscan);
    const to = top + height + overscan;
    const { blocks, tile } = S.layout;

    const needed = new Set();
    const fragment = document.createDocumentFragment();
    const headers = [];

    for (const block of blocks) {
      if (block.y + block.h < from || block.y > to) continue;
      if (block.type === 'header') {
        const el = document.createElement('div');
        el.className = 'date-head';
        el.style.top = `${block.y + PAD - 6}px`;
        el.style.left = `${PAD}px`;
        el._ids = block.ids || [];
        el.innerHTML = `<button class="d-check" type="button" title="选择这一天的全部内容" aria-pressed="false"></button>`
          + `<span class="d-label">${esc(block.label)}</span><span class="d-count">${block.count} 项</span>`;
        el.querySelector('.d-check').addEventListener('click', (e) => {
          e.stopPropagation();
          toggleGroupSelection(el._ids || []);
        });
        applyGroupCheckState(el);
        headers.push(el);
        continue;
      }
      block.items.forEach((item, idx) => {
        needed.add(item.id);
        let el = tileCache.get(item.id);
        if (!el) {
          el = createTile(item);
          tileCache.set(item.id, el);
        } else {
          syncTile(el, item);
        }
        const x = PAD + idx * (tile + GAP);
        const y = block.y + PAD;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.width = `${tile}px`;
        el.style.height = `${tile}px`;
        if (el.parentNode !== content) fragment.appendChild(el);
      });
    }

    content.querySelectorAll('.date-head').forEach((n) => n.remove());
    headers.forEach((h) => content.appendChild(h));
    if (fragment.childNodes.length) content.appendChild(fragment);

    // 回收不可见瓦片，避免 DOM 与解码器膨胀
    for (const [id, el] of tileCache) {
      if (needed.has(id)) continue;
      if (el.parentNode) el.parentNode.removeChild(el);
      const video = el.querySelector('video');
      if (video) { try { video.pause(); } catch {} }
      if (tileCache.size > 520) tileCache.delete(id);
    }
    updateSelectionClasses();
  }

  function playableUrl(item) {
    if (item.type === 'video') return mediaUrl('video', item);
    return mediaUrl('live', item);
  }

  function createTile(item) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.dataset.id = item.id;
    el.dataset.version = String(item.updatedAt || 0);

    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.src = mediaUrl('thumb', item, { size: 480 });
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => {
      if (item.displaySupported === false) img.classList.add('loaded');
    }, { once: true });
    el.appendChild(img);

    if (item.type === 'live' || item.type === 'video') {
      const video = document.createElement('video');
      video.className = 'live-video';
      video.loop = true;
      video.playsInline = true;
      video.preload = 'none';
      el.appendChild(video);

      const SVG_ON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
      const SVG_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><line x1="15" y1="9" x2="21" y2="15"/><line x1="21" y1="9" x2="15" y2="15"/></svg>';
      const soundBtn = document.createElement('button');
      soundBtn.type = 'button';
      soundBtn.className = 'sound-toggle';
      soundBtn.title = '静音 / 取消静音';
      soundBtn.innerHTML = SVG_ON;
      soundBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        video.muted = !video.muted;
        soundBtn.innerHTML = video.muted ? SVG_OFF : SVG_ON;
        soundBtn.classList.toggle('off', video.muted);
      });
      el.appendChild(soundBtn);
    }

    if (item.type === 'live') {
      const badge = document.createElement('div');
      const unsupported = item.motionStatus === 'unsupported';
      badge.className = `badge live${unsupported ? ' unsupported' : ''}`;
      badge.textContent = unsupported ? '实况 · 待支持' : '实况';
      el.appendChild(badge);
    } else if (item.type === 'video') {
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = '视频';
      el.appendChild(badge);
      const dur = document.createElement('div');
      dur.className = 'badge duration';
      dur.textContent = fmtDuration(item.duration);
      el.appendChild(dur);
    } else if (item.displaySupported === false) {
      const badge = document.createElement('div');
      badge.className = 'badge unsupported';
      badge.textContent = '格式待支持';
      el.appendChild(badge);
    }

    if (item.crop) {
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.style.left = 'auto';
      badge.style.right = '8px';
      badge.textContent = '已裁剪';
      el.appendChild(badge);
    }

    const check = document.createElement('button');
    check.className = 'check';
    check.title = '选择';
    check.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelect(item.id, e.shiftKey);
    });
    el.appendChild(check);

    el.addEventListener('click', (e) => {
      if (e.target.closest('.check') || e.target.closest('.sound-toggle')) return;
      if (S.selection.size > 0 || e.ctrlKey || e.metaKey) {
        toggleSelect(item.id, e.shiftKey);
        return;
      }
      openViewer(item);
    });
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (e.target.closest('.sound-toggle') || e.target.closest('.check')) return;
      openViewer(item);
    });
    el.addEventListener('contextmenu', (e) => showItemMenu(e, item));
    return el;
  }

  function syncTile(el, item) {
    if (el.dataset.version !== String(item.updatedAt || 0)) {
      el.dataset.version = String(item.updatedAt || 0);
      const img = el.querySelector('img');
      if (img) img.src = mediaUrl('thumb', item, { size: 480 });
    }
    el.classList.toggle('selected', S.selection.has(item.id));
  }

  function updateSelectionClasses() {
    for (const el of $content().querySelectorAll('.tile')) {
      el.classList.toggle('selected', S.selection.has(el.dataset.id));
    }
    updateDateHeadChecks();
  }

  function applyGroupCheckState(headEl) {
    const ids = headEl._ids || [];
    const all = ids.length > 0 && ids.every((id) => S.selection.has(id));
    const some = !all && ids.some((id) => S.selection.has(id));
    const btn = headEl.querySelector('.d-check');
    if (!btn) return;
    btn.classList.toggle('on', all);
    btn.classList.toggle('partial', some);
    btn.setAttribute('aria-pressed', String(all));
    btn.title = all ? '取消选择这一天的全部内容' : '选择这一天的全部内容';
  }

  function updateDateHeadChecks() {
    for (const el of $content().querySelectorAll('.date-head')) applyGroupCheckState(el);
  }

  /** 日期分组复选框：整组选中 / 整组取消 */
  function toggleGroupSelection(ids) {
    if (!ids.length) return;
    const all = ids.every((id) => S.selection.has(id));
    if (all) ids.forEach((id) => S.selection.delete(id));
    else ids.forEach((id) => S.selection.add(id));
    if (all) S.lastIndex = -1;
    updateSelectionBar();
    updateSelectionClasses();
  }

  // ---------------- 悬停播放 ----------------
  function stopHover() {
    const { tile } = S.hover;
    S.hover.gen += 1;
    if (tile) {
      tile.classList.remove('playing');
      const video = tile.querySelector('video');
      if (video) { try { video.pause(); } catch {} }
    }
    clearTimeout(S.hover.timer);
    S.hover = { timer: null, tile: null, item: null, gen: S.hover.gen };
  }

  function startHover(tile, item) {
    if (item.type === 'video' && item.videoCodec === 'none') return;
    if (item.type === 'live' && item.motionStatus === 'unsupported') return;
    const video = tile.querySelector('video');
    if (!video) return;
    const gen = ++S.hover.gen;
    if (!video.dataset.loaded) {
      video.dataset.loaded = '1';
      video.src = playableUrl(item);
    }
    video.onerror = () => {
      tile.classList.remove('playing');
      tile.classList.add('hover-failed');
    };
    video.play().then(() => {
      if (gen === S.hover.gen && S.hover.tile === tile) tile.classList.add('playing');
    }).catch(() => { tile.classList.remove('playing'); });
  }

  function bindGridEvents() {
    const content = $content();
    content.addEventListener('pointerover', (e) => {
      const tile = e.target.closest('.tile');
      if (!tile || S.hover.tile === tile) return;
      stopHover();
      const item = S.itemMap.get(tile.dataset.id);
      if (!item || (item.type !== 'live' && item.type !== 'video')) return;
      S.hover.tile = tile;
      S.hover.item = item;
      S.hover.timer = setTimeout(() => {
        if (S.hover.tile === tile) startHover(tile, item);
      }, 80);
    });
    content.addEventListener('pointerout', (e) => {
      const tile = e.target.closest('.tile');
      if (!tile || tile !== S.hover.tile) return;
      if (e.relatedTarget && tile.contains(e.relatedTarget)) return;
      stopHover();
    });
    content.addEventListener('dragstart', (e) => e.preventDefault());
  }

  // ---------------- 选择 ----------------
  function toggleSelect(id, range = false) {
    if (range && S.lastIndex >= 0) {
      const target = S.filtered.findIndex((i) => i.id === id);
      if (target >= 0) {
        const [a, b] = [Math.min(S.lastIndex, target), Math.max(S.lastIndex, target)];
        const shouldSelect = !S.selection.has(id);
        for (let i = a; i <= b; i += 1) {
          if (shouldSelect) S.selection.add(S.filtered[i].id);
          else S.selection.delete(S.filtered[i].id);
        }
      }
    } else if (S.selection.has(id)) {
      S.selection.delete(id);
    } else {
      S.selection.add(id);
    }
    S.lastIndex = S.filtered.findIndex((i) => i.id === id);
    updateSelectionBar();
    updateSelectionClasses();
  }

  function updateSelectionBar() {
    const bar = $('#selection-bar');
    const n = S.selection.size;
    if (!n) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    $('#sel-count').textContent = `已选择 ${n} 项`;
    const isTrash = S.view.type === 'trash';
    bar.querySelector('[data-sel="album"]').classList.toggle('hidden', isTrash);
    bar.querySelector('[data-sel="tags"]').classList.toggle('hidden', isTrash);
    bar.querySelector('[data-sel="fav"]').classList.toggle('hidden', isTrash);
    bar.querySelector('[data-sel="export"]').classList.toggle('hidden', isTrash);
    bar.querySelector('[data-sel="reveal"]').classList.toggle('hidden', isTrash);
    bar.querySelector('[data-sel="delete"]').classList.toggle('hidden', isTrash);
    bar.querySelector('[data-sel="restore"]').classList.toggle('hidden', !isTrash);
    bar.querySelector('[data-sel="purge"]').classList.toggle('hidden', !isTrash);
  }

  async function batchAction(action) {
    const ids = [...S.selection];
    if (!ids.length) return;
    if (action === 'cancel') { S.selection.clear(); S.lastIndex = -1; updateSelectionBar(); updateSelectionClasses(); return; }
    if (action === 'album') { openAlbumModal(ids); return; }
    if (action === 'tags') {
      const value = await promptDialog(`为 ${ids.length} 项添加标签（用逗号分隔，追加到现有标签）`, '');
      if (value === null) return;
      const add = value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      if (!add.length) return;
      try {
        await Promise.all(ids.map((id) => {
          const item = S.itemMap.get(id);
          const merged = [...new Set([...(item?.tags || []), ...add])];
          return call(api.updateItem, id, { tags: merged });
        }));
        toast(`已为 ${ids.length} 项添加标签`, 'success');
      } catch {}
      S.selection.clear();
      updateSelectionBar();
      return;
    }
    if (action === 'export') {
      try {
        const r = await call(api.exportItems, ids);
        if (r && r.count) toast(`已导出 ${r.count} 个文件到 ${r.dir}`, 'success');
      } catch {}
      return;
    }
    if (action === 'fav') {
      try {
        await Promise.all(ids.map((id) => call(api.updateItem, id, { favorite: true })));
        toast(`已收藏 ${ids.length} 项`, 'success');
      } catch {}
      S.selection.clear();
      updateSelectionBar();
      return;
    }
    if (action === 'reveal') {
      if (ids[0]) await call(api.revealItem, ids[0]).catch(() => {});
      return;
    }
    if (action === 'delete') {
      const ok = await confirmDialog('删除到回收站', `将 ${ids.length} 项移入回收站，可随时还原。`, '删除');
      if (!ok) return;
      try { await call(api.deleteItems, ids); toast('已移入回收站', 'success'); } catch {}
      S.selection.clear();
      updateSelectionBar();
      return;
    }
    if (action === 'restore') {
      try { await call(api.restoreItems, ids); toast(`已还原 ${ids.length} 项`, 'success'); } catch {}
      S.selection.clear();
      updateSelectionBar();
      return;
    }
    if (action === 'purge') {
      const ok = await confirmDialog('彻底删除', `将永久删除 ${ids.length} 项，无法恢复。`, '永久删除');
      if (!ok) return;
      try { await call(api.purgeItems, ids); toast('已彻底删除', 'success'); } catch {}
      S.selection.clear();
      updateSelectionBar();
    }
  }

  // ---------------- 查看器 ----------------
  function openViewer(item) {
    if (!item) return;
    const list = S.filtered.length ? S.filtered : [item];
    const index = Math.max(0, list.findIndex((i) => i.id === item.id));
    S.viewer = { open: true, list, index, currentId: item.id };
    $('#viewer').classList.remove('hidden');
    showViewerItem();
  }

  function closeViewer() {
    stopViewerVideo();
    setVideoPage(false);
    $('#viewer').classList.add('hidden');
    $('#v-info').classList.add('hidden');
    S.viewer = { open: false, list: [], index: 0, currentId: null };
  }

  function currentViewerItem() {
    return S.viewer.list[S.viewer.index] || null;
  }

  function stopViewerVideo() {
    const video = $('#v-video');
    playerLoading = false;
    try { video.pause(); } catch {}
    video.classList.remove('show');
    video.removeAttribute('src');
    delete video.dataset.itemId;
    delete video.dataset.srcUrl;
    delete video.dataset.playToken;
    video.load();
  }

  function showViewerItem(reloadIfNeeded = true) {
    const item = currentViewerItem();
    if (!item) { closeViewer(); return; }
    S.viewer.currentId = item.id;

    $('#v-name').textContent = item.name;
    const bits = [fmtDate(item.takenAt), item.width && item.height ? `${item.width} × ${item.height}` : '', fmtBytes(item.size)];
    if (item.type === 'live') bits.push(item.motionStatus === 'ready' ? '实况' : '实况（待支持）');
    if (item.type === 'video') bits.push(`视频 ${fmtDuration(item.duration)}`);
    if (item.crop) bits.push('已裁剪');
    $('#v-meta').textContent = bits.filter(Boolean).join(' · ');
    $('#v-counter').textContent = `${S.viewer.index + 1} / ${S.viewer.list.length}`;

    const img = $('#v-img');
    const placeholder = $('#v-placeholder');
    const loading = $('#v-loading');
    img.style.opacity = '0';
    placeholder.classList.add('hidden');
    stopViewerVideo();
    setVideoPage(item.type === 'video');

    let url;
    if (item.type === 'video') url = mediaUrl('thumb', item, { size: 1600 });
    else url = mediaUrl('full', item);

    if (!reloadIfNeeded || img.dataset.url !== url) {
      img.dataset.url = url;
      loading.classList.remove('hidden');
      img.onload = () => {
        loading.classList.add('hidden');
        img.style.opacity = '1';
        placeholder.classList.add('hidden');
      };
      img.onerror = () => {
        loading.classList.add('hidden');
        img.style.opacity = '0';
        placeholder.classList.remove('hidden');
      };
      img.src = url;
      if (!url) { loading.classList.add('hidden'); placeholder.classList.remove('hidden'); }
      preloadViewerNeighbor();
    } else {
      img.style.opacity = '1';
    }

    const favBtn = $('#v-fav');
    favBtn.classList.toggle('on', Boolean(item.favorite));
    favBtn.textContent = `${item.favorite ? '★' : '☆'} 收藏`;

    const cropBtn = $('#v-crop');
    cropBtn.disabled = item.type === 'video' || item.displaySupported === false;

    // 实况 / 视频进入查看器即自动播放，点击画面可暂停或继续
    if (canPlayCurrent()) startViewerVideo(item);

    if (!$('#v-info').classList.contains('hidden')) renderInfo(item);
  }

  /** 当前条目是否可播放（独立视频，或可用的实况动态段） */
  function canPlayCurrent() {
    const item = currentViewerItem();
    if (!item) return false;
    return item.type === 'video' || (item.type === 'live' && item.motionStatus !== 'unsupported');
  }

  /** 预加载下一张，提升查看器切换的即时感 */
  function preloadViewerNeighbor() {
    const n = S.viewer.list.length;
    if (n < 2) return;
    const next = S.viewer.list[(S.viewer.index + 1) % n];
    if (!next) return;
    const url = next.type === 'video' ? mediaUrl('thumb', next, { size: 1600 }) : mediaUrl('full', next);
    if (!url) return;
    const img = new Image();
    img.src = url;
  }

  function refreshViewer() {
    if (!S.viewer.open) return;
    const item = S.itemMap.get(S.viewer.currentId);
    if (!item) { closeViewer(); return; }
    if (item.deletedAt && S.view.type !== 'trash') { closeViewer(); return; }
    const list = S.filtered;
    const idx = list.findIndex((i) => i.id === item.id);
    if (idx >= 0) {
      S.viewer.list = list;
      S.viewer.index = idx;
    }
    showViewerItem(true);
  }

  function navigateViewer(delta) {
    if (!S.viewer.open || !S.viewer.list.length) return;
    const next = (S.viewer.index + delta + S.viewer.list.length) % S.viewer.list.length;
    S.viewer.index = next;
    showViewerItem();
  }

  const HEVC_STORE_URL = 'ms-windows-store://pdp/?ProductId=9n4wgh0z6vhq';
  function installHevcAction() {
    return {
      label: '安装 HEVC 扩展',
      onClick: () => { try { api.openExternal(HEVC_STORE_URL); } catch {} },
    };
  }

  function toggleStagePlayback() {
    if (!canPlayCurrent()) return;
    const item = currentViewerItem();
    const video = $('#v-video');
    if (!video.classList.contains('show')) { startViewerVideo(item); return; }
    if (video.paused) {
      video.play().catch(() => toast('该视频无法在本机解码', 'error', installHevcAction()));
    } else {
      video.pause();
    }
    syncPlayerUI();
    showPlayerControls(false);
  }

  function startViewerVideo(item) {
    const video = $('#v-video');
    const img = $('#v-img');
    if (!item) return;
    if (item.type === 'live' && item.motionStatus === 'unsupported') {
      toast('该实况格式暂不支持播放，原文件已完整保存', 'error');
      return;
    }
    const url = playableUrl(item);
    if (!url) { toast('视频不可用', 'error'); return; }
    // 源变化（裁剪/重导入后 updatedAt 变了）或上次加载失败时，必须重新 load()：
    // media element 一旦进入错误态会一直保持，直接 play() 只会重放旧错误而不会重新拉流
    const stale = video.dataset.itemId !== item.id || video.dataset.srcUrl !== url || video.error;
    if (stale) {
      video.dataset.itemId = item.id;
      video.dataset.srcUrl = url;
      video.src = url;
      video.defaultPlaybackRate = playerRate;
      video.playbackRate = playerRate;
      video.load();
    } else if (playerLoading) {
      return; // 同一源正在加载，等其回调即可
    }
    playerLoading = true;
    $('#v-loading').classList.remove('hidden');
    video.muted = false;
    video.volume = 1;
    // 每次播放尝试使用独立令牌：切换条目或重新加载会中止上一次请求，过期回调直接忽略，避免误报解码失败
    const token = `${item.id}|${url}|${Date.now()}`;
    video.dataset.playToken = token;
    video.play()
      .then(() => {
        if (video.dataset.playToken !== token) return;
        playerLoading = false;
        $('#v-loading').classList.add('hidden');
        img.style.opacity = '0';
        video.classList.add('show');
        syncPlayerUI();
        showPlayerControls();
      })
      .catch(() => {
        if (video.dataset.playToken !== token) return;
        playerLoading = false;
        $('#v-loading').classList.add('hidden');
        video.classList.remove('show');
        img.style.opacity = '1';
        toast('该视频无法在本机解码，可尝试安装系统 HEVC 扩展', 'error', installHevcAction());
      });
  }

  // ---------------- 电影式播放控制 ----------------
  const PLAYER_RATES = [
    [0.25, '0.25x'], [0.5, '0.5x'], [0.75, '0.75x'], [1, '1.0x'],
    [1.25, '1.25x'], [1.5, '1.5x'], [2, '2.0x'],
  ];
  let playerRate = 1;
  let playerLoading = false;
  let controlsTimer = 0;

  function fmtClock(sec) {
    const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function isVideoPage() {
    const item = currentViewerItem();
    return Boolean(item && item.type === 'video');
  }

  function rateLabel(rate) {
    const found = PLAYER_RATES.find(([r]) => r === rate);
    return found ? found[1] : '1.0x';
  }

  function buildSpeedMenu() {
    const menu = $('#vc-speed-menu');
    for (const [rate, label] of PLAYER_RATES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.rate = String(rate);
      btn.setAttribute('role', 'menuitem');
      btn.textContent = label;
      menu.appendChild(btn);
    }
  }

  function closeSpeedMenu() {
    $('#vc-speed-menu').classList.add('hidden');
    $('#vc-speed').setAttribute('aria-expanded', 'false');
  }

  function setVideoPage(on) {
    $('#viewer').classList.toggle('video-mode', on);
    $('#v-controls').classList.toggle('hidden', !on);
    $('#v-controls').classList.remove('hidden-ui');
    closeSpeedMenu();
    if (!on) { clearTimeout(controlsTimer); controlsTimer = 0; }
    else syncPlayerUI();
  }

  function syncPlayerUI() {
    if (!isVideoPage()) return;
    const video = $('#v-video');
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    const cur = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const shown = video.classList.contains('show');
    const playing = shown && !video.paused && !video.ended;

    $('#vc-cur').textContent = fmtClock(cur);
    $('#vc-dur').textContent = fmtClock(dur);
    const seek = $('#vc-seek');
    const percent = dur > 0 ? (cur / dur) * 100 : 0;
    seek.value = String(Math.round(percent * 10));
    seek.style.setProperty('--p', `${percent}%`);

    const toggle = $('#vc-toggle');
    toggle.classList.toggle('playing', playing);
    toggle.title = playing ? '暂停' : '播放';
    toggle.setAttribute('aria-label', playing ? '暂停' : '播放');
    toggle.disabled = false;

    $('#vc-back').disabled = !shown || cur <= 0.2;
    $('#vc-fwd').disabled = !shown || dur <= 0 || cur >= dur - 0.2;
  }

  function showPlayerControls(autoHide = true) {
    if (!isVideoPage()) return;
    const bar = $('#v-controls');
    bar.classList.remove('hidden-ui');
    clearTimeout(controlsTimer);
    controlsTimer = 0;
    const video = $('#v-video');
    const playing = video.classList.contains('show') && !video.paused && !video.ended;
    if (autoHide && playing) {
      controlsTimer = setTimeout(() => {
        if ($('#vc-speed-menu').classList.contains('hidden')) bar.classList.add('hidden-ui');
      }, 2600);
    }
  }

  function seekPlayer(delta) {
    const video = $('#v-video');
    if (!video.classList.contains('show') || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + delta));
    syncPlayerUI();
    showPlayerControls();
  }

  function setPlayerRate(rate) {
    playerRate = rate;
    const video = $('#v-video');
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
    $('#vc-speed-value').textContent = rateLabel(rate);
    $$('#vc-speed-menu button').forEach((b) => b.classList.toggle('active', Number(b.dataset.rate) === rate));
    closeSpeedMenu();
    showPlayerControls();
  }

  /** 拍摄参数格式化：f/1.8 · 1/120s · ISO 100 · 26mm */
  function formatExposure(ex) {
    if (!ex) return '—';
    const parts = [];
    if (ex.fnumber) parts.push(`f/${ex.fnumber}`);
    if (ex.exposureTime) {
      parts.push(ex.exposureTime < 1 ? `1/${Math.round(1 / ex.exposureTime)}s` : `${ex.exposureTime}s`);
    }
    if (ex.iso) parts.push(`ISO ${ex.iso}`);
    if (ex.focalLength) parts.push(`${ex.focalLength}mm`);
    return parts.join(' · ') || '—';
  }

  function renderInfo(item) {
    const panel = $('#v-info');
    // 早期导入的条目缺 EXIF 详情，懒回填后重绘
    if (item.type !== 'video' && item.exposure === undefined && !item._exifLoaded) {
      item._exifLoaded = true;
      api.itemExif(item.id).then((r) => {
        if (!r || !r.ok || !r.data) return;
        const cur = S.itemMap.get(item.id);
        if (!cur) return;
        if (r.data.lens) cur.lens = r.data.lens;
        if (r.data.exposure) cur.exposure = r.data.exposure;
        cur._exifLoaded = true;
        if (currentViewerItem()?.id === item.id && !$('#v-info').classList.contains('hidden')) renderInfo(cur);
      }).catch(() => {});
    }
    const rows = [
      ['文件名', esc(item.name)],
      ['类型', item.type === 'live' ? '实况照片' : item.type === 'video' ? '视频' : '照片'],
      ['分辨率', item.width && item.height ? `${item.width} × ${item.height}` : '—'],
      ['文件大小', fmtBytes(item.size)],
      ['拍摄时间', fmtDate(item.takenAt)],
      ['导入时间', fmtDate(item.importedAt)],
      ['格式', (item.ext || '').replace('.', '').toUpperCase() || '—'],
      ['设备', [item.make, item.model].filter(Boolean).join(' ') || '—'],
      ['镜头', item.lens || '—'],
      ['拍摄参数', formatExposure(item.exposure)],
      ['收藏', item.favorite ? '是' : '否'],
      ['标签', (item.tags || []).join('、') || '—'],
      ['裁剪', item.crop ? `是（${Math.round(item.crop.w * 100)}% × ${Math.round(item.crop.h * 100)}%）` : '否'],
    ];
    if (item.type === 'live') {
      rows.push(['实况来源', item.motionKind === 'paired' ? '同名视频配对' : item.motionKind === 'google' ? 'JPEG 内嵌（Google）' : item.motionKind === 'samsung' ? '尾部追加（Samsung）' : '—']);
      rows.push(['实况编码', item.motionCodec || '—']);
      rows.push(['实况时长', fmtDuration(item.motionDuration || 0)]);
    }
    panel.innerHTML = `
      <h3>文件信息</h3>
      ${rows.map(([k, v]) => `<div class="info-row"><span>${k}</span><span>${v}</span></div>`).join('')}
      <div class="info-row"><span>SHA-256</span><span class="info-hash">${esc((item.hash || '').slice(0, 32))}…</span></div>
      <button class="info-verify" id="info-verify">校验原文件完整性</button>
    `;
    const btn = $('#info-verify');
    if (btn) {
      btn.onclick = async () => {
        btn.textContent = '校验中…';
        try {
          const r = await call(api.verifyItem, item.id);
          if (r.ok) {
            btn.className = 'info-verify ok';
            btn.textContent = '原文件完整（SHA-256 匹配）';
          } else {
            btn.className = 'info-verify bad';
            btn.textContent = `校验未通过：${r.reason || '哈希不一致'}`;
          }
        } catch {
          btn.className = 'info-verify bad';
          btn.textContent = '校验失败';
        }
      };
    }
  }

  async function toggleFavorite() {
    const item = currentViewerItem();
    if (!item) return;
    try {
      await call(api.updateItem, item.id, { favorite: !item.favorite });
    } catch {}
  }

  async function deleteFromViewer() {
    const item = currentViewerItem();
    if (!item) return;
    if (S.view.type === 'trash') {
      const ok = await confirmDialog('彻底删除', '将永久删除该条目，无法恢复。', '永久删除');
      if (!ok) return;
      try { await call(api.purgeItems, [item.id]); closeViewer(); toast('已彻底删除', 'success'); } catch {}
      return;
    }
    const ok = await confirmDialog('删除到回收站', '该条目会移入回收站，可随时还原。', '删除');
    if (!ok) return;
    try {
      await call(api.deleteItems, [item.id]);
      closeViewer();
      toast('已移入回收站', 'success');
    } catch {}
  }

  // ---------------- 右键菜单 ----------------
  function showMenu(x, y, items) {
    const menu = $('#context-menu');
    menu.innerHTML = '';
    for (const it of items) {
      if (it.sep) {
        const sep = document.createElement('div');
        sep.className = 'sep';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.textContent = it.label;
      if (it.danger) btn.className = 'danger';
      btn.onclick = (e) => { e.stopPropagation(); hideMenu(); it.action(); };
      menu.appendChild(btn);
    }
    menu.classList.remove('hidden');
    menu.style.left = '0px';
    menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 10)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 10)}px`;
  }

  function hideMenu() { $('#context-menu').classList.add('hidden'); }

  function showItemMenu(e, item) {
    e.preventDefault();
    e.stopPropagation();
    hideMenu();
    const inTrash = Boolean(item.deletedAt);
    const items = [
      { label: '打开', action: () => openViewer(item) },
      { label: item.favorite ? '取消收藏' : '收藏', action: async () => {
        try { await call(api.updateItem, item.id, { favorite: !item.favorite }); } catch {}
      } },
      { label: '加入相册…', action: () => openAlbumModal([item.id]) },
      { label: '编辑标签…', action: async () => {
        const value = await promptDialog('编辑标签（用逗号分隔）', (item.tags || []).join(', '));
        if (value === null) return;
        const tags = value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
        try { await call(api.updateItem, item.id, { tags }); toast('标签已更新', 'success'); } catch {}
      } },
      { sep: true },
      { label: '在文件夹中显示', action: () => call(api.revealItem, item.id).catch(() => {}) },
      { sep: true },
      inTrash
        ? { label: '还原', action: async () => { try { await call(api.restoreItems, [item.id]); toast('已还原', 'success'); } catch {} } }
        : { label: '删除到回收站', danger: true, action: async () => {
          const ok = await confirmDialog('删除到回收站', '该条目会移入回收站，可随时还原。', '删除');
          if (!ok) return;
          try { await call(api.deleteItems, [item.id]); toast('已移入回收站', 'success'); } catch {}
        } },
      inTrash
        ? { label: '彻底删除', danger: true, action: async () => {
          const ok = await confirmDialog('彻底删除', '将永久删除该条目，无法恢复。', '永久删除');
          if (!ok) return;
          try { await call(api.purgeItems, [item.id]); toast('已彻底删除', 'success'); } catch {}
        } }
        : null,
    ].filter(Boolean);
    showMenu(e.clientX, e.clientY, items);
  }

  // ---------------- 对话框 ----------------
  let promptResolve = null;
  function promptDialog(title, value = '') {
    $('#prompt-title').textContent = title;
    const input = $('#prompt-input');
    input.value = value;
    $('#prompt-modal').classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 30);
    return new Promise((resolve) => { promptResolve = resolve; });
  }
  function closePrompt(result) {
    $('#prompt-modal').classList.add('hidden');
    if (promptResolve) { promptResolve(result); promptResolve = null; }
  }

  let confirmResolve = null;
  function confirmDialog(title, text, okLabel = '确定') {
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okLabel;
    $('#confirm-modal').classList.remove('hidden');
    return new Promise((resolve) => { confirmResolve = resolve; });
  }
  function closeConfirm(result) {
    $('#confirm-modal').classList.add('hidden');
    if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
  }

  // ---------------- 相册选择 ----------------
  function openAlbumModal(ids) {
    const modal = $('#album-modal');
    const body = $('#album-modal-body');
    $('#album-modal-title').textContent = ids.length > 1 ? `将 ${ids.length} 项加入相册` : '加入相册';
    const initial = new Map();
    body.innerHTML = '';
    if (!S.albums.length) {
      body.innerHTML = '<div class="album-empty">还没有相册，先新建一个吧。</div>';
    }
    for (const album of S.albums) {
      const idsHave = ids.filter((id) => (S.itemMap.get(id)?.albumIds || []).includes(album.id)).length;
      initial.set(album.id, idsHave === ids.length && ids.length > 0);
      const row = document.createElement('label');
      row.className = 'album-row';
      row.innerHTML = `
        <input type="checkbox" data-album="${album.id}" ${initial.get(album.id) ? 'checked' : ''} />
        <span class="album-name">${esc(album.name)}</span>
        <span class="album-count">${idsHave ? `${idsHave}/${ids.length}` : ''}</span>
      `;
      body.appendChild(row);
    }
    modal.dataset.ids = JSON.stringify(ids);
    modal._initial = initial;
    modal.classList.remove('hidden');
  }

  async function applyAlbumModal() {
    const modal = $('#album-modal');
    const ids = JSON.parse(modal.dataset.ids || '[]');
    const initial = modal._initial || new Map();
    const checks = [...modal.querySelectorAll('input[data-album]')];
    try {
      for (const cb of checks) {
        const albumId = cb.dataset.album;
        const was = initial.get(albumId);
        if (cb.checked && !was) await call(api.addToAlbum, ids, albumId);
        else if (!cb.checked && was) await call(api.removeFromAlbum, ids, albumId);
      }
      toast('相册已更新', 'success');
    } catch {}
    modal.classList.add('hidden');
  }

  // ---------------- 裁剪 ----------------
  function openCrop(item) {
    if (!item || item.type === 'video') return;
    if (item.displaySupported === false) { toast('该格式暂不支持裁剪', 'error'); return; }
    S.crop = {
      item,
      rect: item.crop ? { ...item.crop } : { x: 0, y: 0, w: 1, h: 1 },
      imgRect: null,
      aspect: 0,
      natural: { w: item.width || 0, h: item.height || 0 },
      changed: false,
    };
    const img = $('#crop-img');
    img.style.opacity = '0';
    img.onload = () => {
      img.style.opacity = '1';
      layoutCropImage();
      updateCropUI();
    };
    img.onerror = () => { toast('无法加载原图', 'error'); closeCrop(); };
    img.src = mediaUrl('source', item);
    $('#crop-modal').classList.remove('hidden');
    $$('#crop-aspects button').forEach((b) => b.classList.toggle('active', b.dataset.aspect === '0'));
    $('#crop-size').textContent = '';
    $('#crop-rect').style.display = 'block';
    if (img.complete && img.naturalWidth) { layoutCropImage(); updateCropUI(); }
  }

  function closeCrop() {
    $('#crop-modal').classList.add('hidden');
    $('#crop-img').removeAttribute('src');
    S.crop = null;
  }

  function layoutCropImage() {
    if (!S.crop) return;
    const img = $('#crop-img');
    const stage = $('#crop-stage');
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const nw = img.naturalWidth || S.crop.natural.w;
    const nh = img.naturalHeight || S.crop.natural.h;
    if (!nw || !nh) return;
    const scale = Math.min(sw / nw, sh / nh, 1);
    const w = nw * scale;
    const h = nh * scale;
    const left = (sw - w) / 2;
    const top = (sh - h) / 2;
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    img.style.left = `${left}px`;
    img.style.top = `${top}px`;
    S.crop.imgRect = { left, top, w, h };
    S.crop.natural = { w: nw, h: nh };
  }

  function updateCropUI() {
    if (!S.crop || !S.crop.imgRect) return;
    const { rect, imgRect, natural } = S.crop;
    const el = $('#crop-rect');
    el.style.left = `${imgRect.left + rect.x * imgRect.w}px`;
    el.style.top = `${imgRect.top + rect.y * imgRect.h}px`;
    el.style.width = `${rect.w * imgRect.w}px`;
    el.style.height = `${rect.h * imgRect.h}px`;
    const pxW = Math.max(1, Math.round(rect.w * natural.w));
    const pxH = Math.max(1, Math.round(rect.h * natural.h));
    $('#crop-size').textContent = `${pxW} × ${pxH} px · 原图 ${natural.w} × ${natural.h}`;
  }

  function fitAspect(rect, aspect) {
    if (!aspect || !S.crop) return rect;
    const { natural } = S.crop;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    let w = rect.w;
    let h = rect.h;
    const cur = (w * natural.w) / (h * natural.h);
    if (cur > aspect) w = (h * natural.h * aspect) / natural.w;
    else h = (w * natural.w) / (aspect * natural.h);
    w = Math.min(w, 1);
    h = Math.min(h, 1);
    let x = cx - w / 2;
    let y = cy - h / 2;
    x = Math.max(0, Math.min(1 - w, x));
    y = Math.max(0, Math.min(1 - h, y));
    return { x, y, w, h };
  }

  function clampRect(rect) {
    let w = Math.max(0.02, Math.min(1, rect.w));
    let h = Math.max(0.02, Math.min(1, rect.h));
    let x = Math.max(0, Math.min(1 - w, rect.x));
    let y = Math.max(0, Math.min(1 - h, rect.y));
    return { x, y, w, h };
  }

  function bindCropDrag() {
    const rectEl = $('#crop-rect');
    let drag = null;

    const onMove = (e) => {
      if (!drag || !S.crop) return;
      const { imgRect } = S.crop;
      const dx = (e.clientX - drag.sx) / imgRect.w;
      const dy = (e.clientY - drag.sy) / imgRect.h;
      let r = { ...drag.rect };
      const m = drag.mode;
      if (m === 'move') {
        r.x = drag.rect.x + dx;
        r.y = drag.rect.y + dy;
      } else {
        if (m.includes('w')) { r.x = drag.rect.x + dx; r.w = drag.rect.w - dx; }
        if (m.includes('e')) { r.w = drag.rect.w + dx; }
        if (m.includes('n')) { r.y = drag.rect.y + dy; r.h = drag.rect.h - dy; }
        if (m.includes('s')) { r.h = drag.rect.h + dy; }
        if (r.w < 0.02) { r.w = 0.02; if (m.includes('w')) r.x = drag.rect.x + drag.rect.w - 0.02; }
        if (r.h < 0.02) { r.h = 0.02; if (m.includes('n')) r.y = drag.rect.y + drag.rect.h - 0.02; }
        r = clampRect(r);
        if (S.crop.aspect) r = clampRect(fitAspect(r, S.crop.aspect));
      }
      S.crop.rect = clampRect(r);
      S.crop.changed = true;
      updateCropUI();
    };

    const onUp = () => {
      drag = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    rectEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !S.crop || !S.crop.imgRect) return;
      e.preventDefault();
      const handle = e.target.closest('.handle');
      drag = {
        mode: handle ? handle.dataset.h : 'move',
        sx: e.clientX,
        sy: e.clientY,
        rect: { ...S.crop.rect },
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    $$('#crop-aspects button').forEach((btn) => {
      btn.onclick = () => {
        if (!S.crop) return;
        S.crop.aspect = Number(btn.dataset.aspect) || 0;
        $$('#crop-aspects button').forEach((b) => b.classList.toggle('active', b === btn));
        if (S.crop.aspect) {
          S.crop.rect = clampRect(fitAspect(S.crop.rect, S.crop.aspect));
          S.crop.changed = true;
          updateCropUI();
        }
      };
    });
  }

  async function saveCropRect(closeAfter = true) {
    if (!S.crop) return false;
    const { item, rect } = S.crop;
    try {
      const saved = await call(api.saveCrop, item.id, rect);
      if (item.type === 'live') {
        toast(`已生成新的裁剪实况：${saved.name}`, 'success');
      } else {
        toast(`已另存为新图：${saved.name}（原图未改动）`, 'success');
      }
      if (closeAfter) closeCrop();
      await refreshState();
      return true;
    } catch { return false; }
  }

  // ---------------- 设置 ----------------
  function openSettings() {
    if (S.app) {
      $('#setting-root').textContent = S.app.root || '—';
      $('#setting-about').textContent = `照片仓库 v${S.app.appVersion || '1.0.0'} · 本地优先 · 不做云端上传`;
      $('#trash-auto-clean').value = String(S.app.ui?.trashAutoCleanDays || 0);
    }
    $('#settings-modal').classList.remove('hidden');
  }

  function closeSettings() { $('#settings-modal').classList.add('hidden'); }

  // ---------- 相似照片清理 ----------
  let similarScanText = '正在分析照片指纹…';

  async function openSimilar() {
    closeSettings();
    const body = $('#similar-body');
    body.innerHTML = `<div class="sim-status">${similarScanText}</div>`;
    $('#similar-modal').classList.remove('hidden');
    let res;
    try {
      res = await call(api.findSimilar);
    } catch { body.innerHTML = '<div class="sim-status">扫描失败</div>'; return; }
    similarScanText = '正在分析照片指纹…';
    const groups = (res && res.groups) || [];
    if (!groups.length) {
      body.innerHTML = `<div class="sim-status">没有发现相似照片（已扫描 ${res?.scanned || 0} 张）</div>`;
      return;
    }
    renderSimilarGroups(groups);
  }

  function renderSimilarGroups(groups) {
    const body = $('#similar-body');
    body.innerHTML = '';
    for (const ids of groups) {
      const items = ids.map((id) => S.itemMap.get(id)).filter(Boolean);
      if (items.length < 2) continue;
      const g = document.createElement('div');
      g.className = 'sim-group';
      const cells = items.map((it, idx) => `
        <label class="sim-cell" data-id="${esc(it.id)}">
          <img src="${mediaUrl('thumb', it, { size: 240 })}" loading="lazy" alt="" />
          <span class="sim-name" title="${esc(it.name)}">${esc(it.name)}</span>
          <span class="sim-meta">${fmtBytes(it.size)}</span>
          <span class="sim-keep"><input type="radio" name="keep-${esc(g.dataset.gid || '')}" ${idx === 0 ? 'checked' : ''} data-keep="${esc(it.id)}" /> 保留</span>
        </label>`).join('');
      g.innerHTML = `<div class="sim-row">${cells}</div>
        <div class="sim-foot"><button class="ghost danger sim-del">删除其余 ${items.length - 1} 张到回收站</button></div>`;
      const gid = `g${Math.random().toString(36).slice(2, 8)}`;
      g.querySelectorAll('input[type=radio]').forEach((r) => { r.name = `keep-${gid}`; });
      g.querySelector('.sim-del').onclick = async (e) => {
        const keep = g.querySelector('input[type=radio]:checked')?.dataset.keep;
        const delIds = items.map((i) => i.id).filter((id) => id !== keep);
        if (!delIds.length) return;
        e.target.disabled = true;
        try {
          await call(api.deleteItems, delIds);
          toast(`已移入回收站 ${delIds.length} 张`, 'success');
          g.remove();
          if (!body.querySelector('.sim-group')) body.innerHTML = '<div class="sim-status">全部处理完毕</div>';
        } catch { e.target.disabled = false; }
      };
      body.appendChild(g);
    }
    if (!body.children.length) body.innerHTML = '<div class="sim-status">没有发现相似照片</div>';
  }

  // ---------- 手机传输（有线：检测设备 → 选择相册文件 → 直接导入） ----------
  let phoneGroups = [];
  let phonePicked = new Set();
  let phoneBusy = false;
  let phoneCancelPending = false;

  function formatSize(n) {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
  }

  function openPhoneTransfer() {
    $('#phone-modal').classList.remove('hidden');
    loadPhoneMedia();
  }

  function closePhoneTransfer() {
    if (phoneBusy) return;
    $('#phone-modal').classList.add('hidden');
    if (wifiOn) stopWifiImport();
  }

  // ---------- WiFi 导入 ----------
  let wifiOn = false;

  async function startWifiImport() {
    const btn = $('#wifi-toggle');
    btn.disabled = true;
    try {
      const r = await call(api.phone.wifiStart);
      if (!r || !r.ok) throw new Error((r && r.error) || '启动失败');
      wifiOn = true;
      btn.textContent = '关闭';
      $('#wifi-panel').classList.remove('hidden');
      if (r.qr) $('#wifi-qr').src = r.qr;
      $('#wifi-url').textContent = r.url;
      $('#wifi-log').innerHTML = '';
      renderWifiIps(r.urls || []);
    } catch {} finally { btn.disabled = false; }
  }

  /** 候选网卡列表：系统接口识别出的真实网卡，选中哪块就换成对应二维码 */
  function renderWifiIps(urls) {
    const sel = $('#wifi-ip');
    sel.innerHTML = '';
    if (!urls.length) { sel.classList.add('hidden'); return; }
    for (const u of urls) {
      const opt = document.createElement('option');
      opt.value = u.ip;
      const kind = u.virtual ? '虚拟网卡，手机连不上' : u.wifi ? 'Wi-Fi' : '有线';
      opt.textContent = `${u.ip} · ${u.name}（${kind}）`;
      opt.title = u.desc || '';
      sel.appendChild(opt);
    }
    sel.value = urls[0].ip;
    sel.classList.remove('hidden');
    sel.onchange = () => {
      const hit = urls.find((u) => u.ip === sel.value);
      if (!hit) return;
      if (hit.qr) $('#wifi-qr').src = hit.qr;
      $('#wifi-url').textContent = hit.url;
    };
  }

  async function allowWifiFirewall() {
    const btn = $('#wifi-firewall');
    btn.disabled = true;
    btn.textContent = '正在添加规则…';
    try {
      const r = await call(api.phone.wifiFirewall);
      toast(r && r.existed ? '防火墙规则已存在，无需重复添加' : '已放行本机局域网端口，请重新扫码', 'success');
    } catch {
    } finally {
      btn.disabled = false;
      btn.textContent = '页面打不开？放行防火墙';
    }
  }

  async function stopWifiImport() {
    const btn = $('#wifi-toggle');
    btn.disabled = true;
    try { await call(api.phone.wifiStop); } catch {}
    wifiOn = false;
    btn.disabled = false;
    btn.textContent = '开启';
    $('#wifi-panel').classList.add('hidden');
  }

  function appendWifiLog(p) {
    if (!p || !p.name) return;
    const log = $('#wifi-log');
    let row = log.querySelector(`[data-wf="${CSS.escape(p.name)}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'wf-row';
      row.dataset.wf = p.name;
      row.innerHTML = `<span class="wf-name" title="${esc(p.name)}">${esc(p.name)}</span><span class="wf-st"></span>`;
      log.prepend(row);
      while (log.children.length > 30) log.lastChild.remove();
    }
    const st = row.querySelector('.wf-st');
    const label = { receiving: '接收中', importing: '入库中', done: '已入库', dup: '已存在', failed: '失败' }[p.state] || p.state;
    st.textContent = p.state === 'receiving' && p.size ? `${label} ${Math.round((p.received || 0) / p.size * 100)}%` : label;
    st.className = `wf-st ${p.state}`;
    if (p.state === 'failed' && p.message) {
      // 失败原因必须可见，否则用户只能看到「失败」两个字
      row.title = p.message;
      st.textContent = `失败：${p.message}`;
    }
  }

  async function loadPhoneMedia() {
    if (phoneBusy) return;
    const stateEl = $('#phone-detect-state');
    const listEl = $('#phone-media-list');
    const toolbar = $('#phone-toolbar');
    const tip = $('#phone-detect-tip');
    const refresh = $('#phone-refresh');
    phoneGroups = [];
    phonePicked = new Set();
    listEl.innerHTML = '';
    listEl.classList.add('hidden');
    toolbar.classList.add('hidden');
    tip.classList.add('hidden');
    $('#phone-import-progress').className = 'phone-import-progress hidden';
    phoneCancelPending = false;
    syncPhoneSelection();
    stateEl.className = 'phone-detect-state';
    stateEl.textContent = '正在检测设备…';
    refresh.disabled = true;
    try {
      const det = await api.phone.detect();
      if (!det || !det.ok) throw new Error((det && det.error) || '检测失败');
      if (!det.data || !det.data.found) {
        stateEl.classList.add('off');
        stateEl.textContent = '未检测到设备';
        tip.classList.remove('hidden');
        return;
      }
      stateEl.classList.add('on');
      stateEl.textContent = '已检测到设备，请耐心等待';

      const res = await api.phone.list();
      if (!res || !res.ok) throw new Error((res && res.error) || '读取手机相册失败');
      const data = res.data || {};
      if (!data.found) {
        stateEl.className = 'phone-detect-state off';
        stateEl.textContent = '未检测到设备';
        tip.classList.remove('hidden');
        return;
      }
      phoneGroups = Array.isArray(data.groups) ? data.groups : [];
      stateEl.className = 'phone-detect-state on';
      stateEl.innerHTML = `<span class="dot-on"></span>已检测到设备，共 ${phoneGroups.length} 项`;
      if (!phoneGroups.length) {
        tip.classList.remove('hidden');
        return;
      }
      toolbar.classList.remove('hidden');
      listEl.classList.remove('hidden');
      renderPhoneGroups();
      // 封面按需异步生成，生成一张就替换一张占位
      api.phone.thumbs(phoneGroups.map((g) => ({
        id: g.id, files: g.files, kind: g.kind, size: g.size,
      }))).catch(() => {});
    } catch (e) {
      stateEl.className = 'phone-detect-state off';
      stateEl.textContent = '检测失败';
      toast('检测手机失败：' + e.message, 'error');
    } finally {
      refresh.disabled = false;
    }
  }

  function phoneThumbHtml(g, i) {
    const icon = { live: '◉', image: '▣', video: '▶' }[g.kind] || '▣';
    return `<span class="pm-thumb" data-i="${i}"><span class="pm-ph ${g.kind}">${icon}</span></span>`;
  }

  function applyPhoneThumb(id, url) {
    const i = phoneGroups.findIndex((g) => g.id === id);
    if (i < 0) return;
    const el = $('#phone-media-list').querySelector(`.pm-thumb[data-i="${i}"]`);
    if (!el) return;
    const img = new Image();
    img.alt = '';
    img.onload = () => {
      if (!el.isConnected) return;
      el.innerHTML = '';
      el.appendChild(img);
      el.classList.add('has-img');
    };
    img.src = url;
  }

  function renderPhoneGroups() {
    const listEl = $('#phone-media-list');
    if (!phoneGroups.length) {
      listEl.innerHTML = '<div class="phone-empty">手机相册里没有可导入的照片或视频</div>';
    } else {
      const kindLabel = { live: '实况', image: '照片', video: '视频' };
      listEl.innerHTML = phoneGroups.map((g, i) => `
        <label class="phone-media${phonePicked.has(g.id) ? ' checked' : ''}${g.imported ? ' imported' : ''}" title="${g.imported ? '库中已有同名同大小的文件，可能已导入过' : ''}">
          ${phoneThumbHtml(g, i)}
          ${g.imported ? '<span class="pm-imported-badge">已导入</span>' : ''}
          <span class="pm-meta">
            <span class="pm-row">
              <input type="checkbox" data-key="${esc(g.id)}" ${phonePicked.has(g.id) ? 'checked' : ''} />
              <span class="pm-kind ${g.kind}">${kindLabel[g.kind] || g.kind}</span>
            </span>
            <span class="pm-name" title="${esc(g.label)}">${esc(g.label)}</span>
            <span class="pm-size">${formatSize(g.size)}</span>
          </span>
        </label>`).join('');
    }
    syncPhoneSelection();
  }

  function syncPhoneSelection() {
    const fresh = phoneGroups.filter((g) => !g.imported);
    $('#phone-select-all').checked = fresh.length > 0 && fresh.every((g) => phonePicked.has(g.id));
    $('#phone-summary').textContent = phonePicked.size ? `已选 ${phonePicked.size} 项` : '';
    updatePhoneImportButton();
  }

  function updatePhoneImportButton() {
    const btn = $('#phone-import-selected');
    const cancel = $('#phone-cancel-import');
    btn.disabled = phoneBusy || phonePicked.size === 0;
    if (phoneBusy) btn.textContent = phoneCancelPending ? '正在取消…' : '正在导入…';
    else if (phonePicked.size) btn.textContent = `导入所选（${phonePicked.size}）`;
    else btn.textContent = '导入所选';
    // 导入期间才出现「取消导入」，位置始终在固定底栏内
    cancel.classList.toggle('hidden', !phoneBusy);
    cancel.disabled = phoneCancelPending;
    cancel.textContent = phoneCancelPending ? '正在取消…' : '取消导入';
  }

  /** 取消导入：只置标记，已开始的条目继续完成，未开始的条目在下一个条目边界截止 */
  async function requestPhoneCancel() {
    if (!phoneBusy || phoneCancelPending) return;
    phoneCancelPending = true;
    updatePhoneImportButton();
    $('#phone-import-phase').textContent = '正在取消…';
    $('#phone-import-sub').textContent = '已开始的条目会继续完成，未开始的条目不再导入';
    try { await api.phone.cancelImport(); } catch {}
  }

  /** 手机导入进度条：覆盖「从手机复制 → 入库」两个阶段，实时刷新 */
  function renderPhoneImportProgress(p) {
    const box = $('#phone-import-progress');
    if (!box || box.classList.contains('hidden')) return;
    const phaseEl = $('#phone-import-phase');
    const curEl = $('#phone-import-current');
    const fill = $('#phone-import-fill');
    const sub = $('#phone-import-sub');
    const total = p.total || 0;
    const name = String(p.current || '').split(/[\\/]/).pop();
    if (p.phase === 'copy') {
      // 复制阶段按文件计数，单文件内再按已落地字节平滑，避免大视频时进度条长时间不动
      const frac = p.fileTotal > 0 ? Math.min(1, (p.fileDone || 0) / p.fileTotal) : 0;
      const pct = total ? Math.min(100, Math.round(((p.done + frac) / total) * 100)) : 0;
      const itemTotal = p.itemTotal || 0;
      const itemDone = p.itemDone || 0;
      phaseEl.textContent = phoneCancelPending
        ? `正在取消… 已完成 ${itemDone}/${itemTotal} 项`
        : `第 1/2 步 · 正在从手机复制 ${itemTotal ? Math.min(itemDone + 1, itemTotal) : 0}/${itemTotal} 项 · ${pct}%`;
      sub.textContent = phoneCancelPending ? '已开始的条目会继续完成，未开始的条目不再导入' : '直接写入照片存储位置，不再经过系统盘中转';
      curEl.textContent = name;
      fill.style.width = `${pct}%`;
    } else if (p.phase === 'import') {
      const pct = total ? Math.min(100, Math.round((p.done / total) * 100)) : 0;
      phaseEl.textContent = phoneCancelPending
        ? `正在完成已开始的条目 · 已入库 ${p.done}/${total}`
        : `第 2/2 步 · 正在入库 ${p.done}/${total} · ${pct}%`;
      sub.textContent = `新增 ${p.added || 0} · 跳过 ${p.skipped || 0}`;
      curEl.textContent = name;
      fill.style.width = `${pct}%`;
    }
  }

  async function importFromPhone() {
    if (phoneBusy) return;
    const picked = phoneGroups.filter((g) => phonePicked.has(g.id));
    // 按「条目」分组传给主进程：实况的图片+视频同一组，取消时整条一起截断
    const groups = picked.map((g) => (g.files || []).filter(Boolean)).filter((g) => g.length);
    const rels = groups.reduce((acc, g) => acc.concat(g), []);
    if (!rels.length) return;
    const stateEl = $('#phone-detect-state');
    const refresh = $('#phone-refresh');
    const progBox = $('#phone-import-progress');
    phoneBusy = true;
    phoneCancelPending = false;
    refresh.disabled = true;
    updatePhoneImportButton();
    stateEl.className = 'phone-detect-state on';
    stateEl.innerHTML = `<span class="dot-on"></span>正在导入 ${picked.length} 项（共 ${rels.length} 个文件）…`;
    progBox.className = 'phone-import-progress';
    $('#phone-import-phase').textContent = '第 1/2 步 · 正在从手机复制…';
    $('#phone-import-current').textContent = '';
    $('#phone-import-fill').style.width = '0%';
    $('#phone-import-sub').textContent = '';
    const off = api.on('phone-import-progress', (p) => {
      if (p && p.phase) renderPhoneImportProgress(p);
    });
    try {
      const res = await api.phone.importSelected(groups);
      off();
      if (!res || !res.ok) throw new Error((res && res.error) || '导入失败');
      const s = res.data.summary || {};
      const parts = [`新增 ${s.added || 0}`];
      if (s.skipped) parts.push(`重复跳过 ${s.skipped}`);
      if (s.live) parts.push(`实况 ${s.live}`);
      if (s.failed && s.failed.length) parts.push(`失败 ${s.failed.length}`);
      if (res.data.cancelled) {
        // 取消态：报告「已完成 / 未导入」条数，未导入数即取消时尚未开始的条目，之后不再增加
        const processed = typeof s.processed === 'number'
          ? s.processed
          : (s.added || 0) + (s.skipped || 0) + ((s.failed && s.failed.length) || 0);
        const remain = Math.max(0, picked.length - processed);
        const pct = picked.length ? Math.round((processed / picked.length) * 100) : 0;
        progBox.classList.add('cancelled');
        $('#phone-import-phase').textContent = '⏹ 已取消导入';
        $('#phone-import-current').textContent = '';
        $('#phone-import-fill').style.width = `${pct}%`;
        $('#phone-import-sub').textContent = `已完成 ${processed} 项（${parts.join(' · ')}）· 未导入 ${remain} 项`;
        stateEl.innerHTML = `<span class="dot-on"></span>已取消：完成 ${processed} 项，未导入 ${remain} 项`;
        toast(`已取消导入：完成 ${processed} 项，未导入 ${remain} 项`, 'success');
        // 保留列表与勾选，方便直接再次导入剩余条目
      } else {
        // 完成态：进度条满格转绿并短暂停留，让用户明确看到导入完成
        progBox.classList.add('done');
        $('#phone-import-phase').textContent = '✓ 导入完成';
        $('#phone-import-current').textContent = '';
        $('#phone-import-fill').style.width = '100%';
        $('#phone-import-sub').textContent = parts.join(' · ');
        stateEl.innerHTML = `<span class="dot-on"></span>导入完成：${parts.join(' · ')}`;
        toast(`手机导入完成：${parts.join(' · ')}`, (s.failed && s.failed.length) ? 'error' : 'success');
        if (res.data.copy && res.data.copy.failed && res.data.copy.failed.length) {
          toast(`${res.data.copy.failed.length} 个文件复制失败，已跳过`, 'error');
        }
        await new Promise((r) => setTimeout(r, 1400));
        phoneGroups = [];
        phonePicked = new Set();
        $('#phone-modal').classList.add('hidden');
      }
    } catch (e) {
      off();
      // 失败态：进度条转红并给出明确原因，弹窗保持打开便于重试
      progBox.classList.add('error');
      $('#phone-import-phase').textContent = '✕ 导入失败';
      $('#phone-import-current').textContent = '';
      $('#phone-import-sub').textContent = e.message || '请重试';
      stateEl.innerHTML = '<span class="dot-off"></span>导入失败';
      toast('从手机导入失败：' + e.message, 'error');
    } finally {
      phoneBusy = false;
      phoneCancelPending = false;
      refresh.disabled = false;
      updatePhoneImportButton();
    }
  }

  async function migrate() {
    const ok = await confirmDialog('迁移存储位置', '将逐文件复制并做 SHA-256 校验，原库会完整保留。迁移期间请勿拔出介质。', '开始迁移');
    if (!ok) return;
    setBanner('<span id="banner-text">正在准备迁移…</span>');
    const off = api.on('migrate-progress', (p) => {
      const el = $('#banner-text');
      if (el) el.textContent = `正在迁移 ${p.done}/${p.total}：${p.current || ''}`;
    });
    try {
      const res = await api.migrate();
      off();
      if (!res.ok) throw new Error(res.error || '迁移失败');
      if (!res.data) { setBanner(''); return; }
      setBanner('');
      await refreshState();
      toast(`迁移完成：${res.data.files} 个文件 → ${res.data.root}`, 'success');
    } catch (e) {
      off();
      setBanner(`<span>${esc(e.message)}</span>`, 'error');
      toast('迁移失败，原库未被修改', 'error');
    }
  }

  async function rescan() {
    setBanner('<span id="banner-text">正在重建索引…</span>');
    const off = api.on('rescan-progress', (p) => {
      const el = $('#banner-text');
      if (el) el.textContent = `正在重建索引 ${p.done}/${p.total}`;
    });
    try {
      const data = await call(api.rescan);
      off();
      setBanner('');
      await refreshState();
      toast(`索引已重建（${data.total} 项，新增 ${data.added}，移除 ${data.removed}）`, 'success');
    } catch {
      off();
      setBanner('');
    }
  }

  // ---------------- 导入 ----------------
  async function importPaths(paths) {
    if (!paths || !paths.length) return;
    if (!S.app || !S.app.hasLibrary) { await pickRoot(); return; }
    setBanner(`<span id="banner-text">正在导入 ${paths.length} 个位置…</span>`);
    const off = api.on('import-progress', (p) => {
      renderImportProgress(p);
      if (p.item) mergeImportedItem(p.item);
    });
    try {
      const res = await api.importPaths(paths);
      off();
      if (!res.ok) throw new Error(res.error || '导入失败');
      const s = res.data;
      setBanner('');
      const parts = [`新增 ${s.added}`];
      if (s.skipped) parts.push(`重复跳过 ${s.skipped}`);
      if (s.live) parts.push(`实况 ${s.live}`);
      if (s.failed.length) parts.push(`失败 ${s.failed.length}`);
      toast(`导入完成：${parts.join(' · ')}`, s.failed.length ? 'error' : 'success');
      if (s.failed.length) {
        console.warn('导入失败明细', s.failed);
        setBanner(`<span>有 ${s.failed.length} 个文件导入失败（已跳过，原文件未受影响），详情见 .photo-repo/logs/import.log</span>`, 'error');
      }
    } catch (e) {
      off();
      setBanner(`<span>${esc(e.message)}</span>`, 'error');
    }
  }

  async function pickRoot() {
    try {
      const data = await call(api.pickRoot);
      if (!data) return;
      applyState(data);
      toast('照片仓库已就绪', 'success');
    } catch {}
  }

  async function locateRoot() {
    try {
      const r = await call(api.locateRoot);
      if (!r.found) { toast('未找到匹配的照片仓库', 'error'); return; }
      applyState(r.state);
      toast('已找到并打开照片仓库', 'success');
    } catch {}
  }

  // ---------------- 事件绑定 ----------------
  function bind() {
    $('#nav').addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-item');
      if (!btn) return;
      const type = btn.dataset.nav;
      setView({ type, albumId: null, tag: null });
    });

    $('#media-chips').addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      S.mediaFilter = btn.dataset.media;
      $$('#media-chips .chip').forEach((c) => c.classList.toggle('active', c === btn));
      renderView();
    });

    let searchTimer = null;
    $('#search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        S.search = e.target.value;
        renderView();
        $viewport().scrollTop = 0;
      }, 160);
    });

    // Ctrl + 滚轮调整缩略图大小
    let zoomSaveTimer = null;
    $viewport().addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const next = Math.min(320, Math.max(120, S.tileSize + (e.deltaY < 0 ? 12 : -12)));
      if (next === S.tileSize) return;
      S.tileSize = next;
      renderView(true);
      clearTimeout(zoomSaveTimer);
      zoomSaveTimer = setTimeout(() => { api.setUi({ tileSize: S.tileSize }).catch(() => {}); }, 500);
    }, { passive: false });

    $('#btn-import').onclick = async () => {
      const paths = await call(api.importDialog, 'files').catch(() => null);
      if (paths && paths.length) importPaths(paths);
    };
    $('#btn-import-folder').onclick = async () => {
      const paths = await call(api.importDialog, 'folder').catch(() => null);
      if (paths && paths.length) importPaths(paths);
    };
    $('#btn-phone').onclick = openPhoneTransfer;
    $('#phone-close').onclick = closePhoneTransfer;
    $('#phone-refresh').onclick = loadPhoneMedia;
    $('#wifi-toggle').onclick = () => (wifiOn ? stopWifiImport() : startWifiImport());
    $('#wifi-firewall').onclick = allowWifiFirewall;
    $('#phone-import-selected').onclick = importFromPhone;
    $('#phone-cancel-import').onclick = requestPhoneCancel;
    $('#phone-select-all').onchange = (e) => {
      // 全选只勾选未导入的项，已导入的默认跳过（仍可手动勾选）
      phonePicked = e.target.checked ? new Set(phoneGroups.filter((g) => !g.imported).map((g) => g.id)) : new Set();
      renderPhoneGroups();
    };
    $('#phone-media-list').addEventListener('change', (e) => {
      const key = e.target && e.target.dataset ? e.target.dataset.key : null;
      if (!key) return;
      const on = e.target.checked;
      if (on) phonePicked.add(key);
      else phonePicked.delete(key);
      const card = e.target.closest('.phone-media');
      if (card) card.classList.toggle('checked', on);
      syncPhoneSelection();
    });
    $('#btn-new-album').onclick = async () => {
      const name = await promptDialog('新建相册', '未命名相册');
      if (!name) return;
      try {
        const album = await call(api.createAlbum, name);
        setView({ type: 'album', albumId: album.id });
        toast('相册已创建', 'success');
      } catch {}
    };
    $('#btn-settings').onclick = openSettings;
    $('#settings-close').onclick = closeSettings;
    $('#trash-auto-clean').onchange = async (e) => {
      const days = Math.max(0, Number(e.target.value) || 0);
      try {
        await call(api.setUi, { trashAutoCleanDays: days });
        toast(days ? `已开启：自动清理 ${days} 天前删除的内容` : '已关闭回收站自动清理', 'success');
      } catch {}
    };
    $('#btn-empty-trash').onclick = async () => {
      const n = S.app?.library?.stats?.trash || 0;
      if (!n) { toast('回收站已经是空的'); return; }
      const ok = await confirmDialog('清空回收站', `将永久删除回收站中的 ${n} 项，无法恢复。`, '清空');
      if (!ok) return;
      try { await call(api.emptyTrash); toast('回收站已清空', 'success'); } catch {}
    };
    $('#btn-open-root').onclick = () => call(api.openRoot).catch(() => {});
    $('#btn-migrate').onclick = migrate;
    $('#btn-rescan').onclick = rescan;
    $('#btn-similar').onclick = openSimilar;
    $('#similar-close').onclick = () => $('#similar-modal').classList.add('hidden');
    $('#btn-clear-cache').onclick = async () => {
      try {
        await call(api.clearCache);
        toast('缓存已清理，缩略图会按需重建', 'success');
        renderView(true);
      } catch {}
    };

    $('#btn-choose-root').onclick = pickRoot;
    $('#btn-locate-root').onclick = locateRoot;

    $('#selection-bar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sel]');
      if (btn) batchAction(btn.dataset.sel);
    });

    $viewport().addEventListener('scroll', () => {
      if (S.scrollTick) return;
      S.scrollTick = requestAnimationFrame(() => {
        S.scrollTick = 0;
        stopHover();
        renderWindow();
      });
    });

    window.addEventListener('resize', () => {
      clearTimeout(window.__rz);
      window.__rz = setTimeout(() => { if (S.app && S.app.hasLibrary) renderView(true); }, 120);
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#context-menu')) hideMenu();
    });

    // 查看器
    $('#v-close').onclick = closeViewer;
    $('#v-prev').onclick = () => navigateViewer(-1);
    $('#v-next').onclick = () => navigateViewer(1);
    $('#v-fav').onclick = toggleFavorite;
    $('#v-tags').onclick = async () => {
      const item = currentViewerItem();
      if (!item) return;
      const value = await promptDialog('编辑标签（用逗号分隔）', (item.tags || []).join(', '));
      if (value === null) return;
      const tags = value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      try { await call(api.updateItem, item.id, { tags }); toast('标签已更新', 'success'); } catch {}
    };
    $('#v-albums').onclick = () => {
      const item = currentViewerItem();
      if (item) openAlbumModal([item.id]);
    };
    $('#v-crop').onclick = () => {
      const item = currentViewerItem();
      if (item) openCrop(item);
    };
    $('#v-reveal').onclick = () => {
      const item = currentViewerItem();
      if (item) call(api.revealItem, item.id).catch(() => {});
    };
    $('#v-delete').onclick = deleteFromViewer;

    // 电影式播放控制
    buildSpeedMenu();
    $('#vc-toggle').onclick = () => toggleStagePlayback();
    $('#vc-back').onclick = () => seekPlayer(-10);
    $('#vc-fwd').onclick = () => seekPlayer(10);
    $('#vc-seek').addEventListener('input', (e) => {
      const video = $('#v-video');
      if (!video.classList.contains('show') || !Number.isFinite(video.duration)) return;
      video.currentTime = (Number(e.target.value) / 1000) * video.duration;
      syncPlayerUI();
    });
    $('#vc-speed').onclick = (e) => {
      e.stopPropagation();
      const menu = $('#vc-speed-menu');
      const willOpen = menu.classList.contains('hidden');
      menu.classList.toggle('hidden', !willOpen);
      $('#vc-speed').setAttribute('aria-expanded', String(willOpen));
      if (willOpen) {
        clearTimeout(controlsTimer);
        $$('#vc-speed-menu button').forEach((b) => b.classList.toggle('active', Number(b.dataset.rate) === playerRate));
      }
    };
    $('#vc-speed-menu').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-rate]');
      if (btn) setPlayerRate(Number(btn.dataset.rate));
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.vc-speed-wrap')) closeSpeedMenu();
    });
    $('#v-stage').addEventListener('pointermove', () => showPlayerControls());
    $('#v-controls').addEventListener('pointerenter', () => {
      clearTimeout(controlsTimer);
      $('#v-controls').classList.remove('hidden-ui');
    });
    $('#v-controls').addEventListener('pointerleave', () => showPlayerControls());

    const playerVideoEl = $('#v-video');
    playerVideoEl.addEventListener('timeupdate', syncPlayerUI);
    playerVideoEl.addEventListener('durationchange', syncPlayerUI);
    playerVideoEl.addEventListener('loadedmetadata', () => {
      playerVideoEl.defaultPlaybackRate = playerRate;
      playerVideoEl.playbackRate = playerRate;
      syncPlayerUI();
    });
    playerVideoEl.addEventListener('play', () => { syncPlayerUI(); showPlayerControls(); });
    playerVideoEl.addEventListener('pause', () => { syncPlayerUI(); showPlayerControls(false); });
    playerVideoEl.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleStagePlayback();
    });

    // 点击画面（图片区域同样生效）暂停 / 继续播放
    $('#v-stage').addEventListener('click', (e) => {
      if (e.target.closest('button, input, .v-controls')) return;
      toggleStagePlayback();
    });

    $('#v-video').addEventListener('ended', () => {
      const video = $('#v-video');
      video.classList.remove('show');
      $('#v-img').style.opacity = '1';
    });
    $('#v-info-toggle').onclick = () => {
      const panel = $('#v-info');
      if (panel.classList.contains('hidden')) {
        panel.classList.remove('hidden');
        const item = currentViewerItem();
        if (item) renderInfo(item);
      } else {
        panel.classList.add('hidden');
      }
    };

    // 裁剪
    $('#crop-close').onclick = closeCrop;
    $('#crop-cancel').onclick = closeCrop;
    $('#crop-save').onclick = () => saveCropRect(true);
    $('#crop-reset').onclick = () => {
      if (!S.crop) return;
      S.crop.rect = { x: 0, y: 0, w: 1, h: 1 };
      S.crop.aspect = 0;
      S.crop.changed = true;
      $$('#crop-aspects button').forEach((b) => b.classList.toggle('active', b.dataset.aspect === '0'));
      updateCropUI();
    };
    $('#crop-export').onclick = async () => {
      if (!S.crop) return;
      try {
        const r = await call(api.exportCrop, S.crop.item.id, S.crop.rect);
        if (r) toast(`裁剪副本已导出：${r.file}`, 'success');
      } catch {}
    };
    bindCropDrag();
    window.addEventListener('resize', () => {
      if (S.crop && !$('#crop-modal').classList.contains('hidden')) {
        layoutCropImage();
        updateCropUI();
      }
    });

    // 提示 / 确认
    $('#prompt-ok').onclick = () => closePrompt($('#prompt-input').value.trim());
    $('#prompt-cancel').onclick = () => closePrompt(null);
    $('#prompt-close').onclick = () => closePrompt(null);
    $('#prompt-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') closePrompt(e.target.value.trim());
      if (e.key === 'Escape') closePrompt(null);
    });
    $('#confirm-ok').onclick = () => closeConfirm(true);
    $('#confirm-cancel').onclick = () => closeConfirm(false);

    // 相册弹窗
    $('#album-modal-close').onclick = () => $('#album-modal').classList.add('hidden');
    $('#album-cancel').onclick = () => $('#album-modal').classList.add('hidden');
    $('#album-apply').onclick = applyAlbumModal;
    $('#album-create').onclick = async () => {
      const name = await promptDialog('新建相册', '未命名相册');
      if (!name) return;
      try {
        const album = await call(api.createAlbum, name);
        const ids = JSON.parse($('#album-modal').dataset.ids || '[]');
        $('#album-modal').classList.add('hidden');
        if (ids.length) openAlbumModal(ids);
        toast(`相册「${album.name}」已创建`, 'success');
      } catch {}
    };

    // 拖放
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
      dragDepth += 1;
      $('#drop-overlay').classList.remove('hidden');
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('#drop-overlay').classList.add('hidden');
    });
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      const count = e.dataTransfer?.items?.length || 0;
      const label = $('#drop-overlay .drop-inner');
      if (label) label.textContent = count > 1 ? `松开以导入 ${count} 个项目` : '松开以导入到照片仓库';
    });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      $('#drop-overlay').classList.add('hidden');
      const files = [...(e.dataTransfer?.files || [])];
      const paths = files.map((f) => api.getPathForFile(f)).filter(Boolean);
      if (!paths.length) { toast('无法读取拖入的文件路径', 'error'); return; }
      importPaths(paths);
    });

    // 键盘
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      if (e.key === 'Escape') {
        if (!$('#confirm-modal').classList.contains('hidden')) return closeConfirm(false);
        if (!$('#prompt-modal').classList.contains('hidden')) return closePrompt(null);
        if (!$('#album-modal').classList.contains('hidden')) return $('#album-modal').classList.add('hidden');
        if (!$('#crop-modal').classList.contains('hidden')) return closeCrop();
        if (!$('#settings-modal').classList.contains('hidden')) return closeSettings();
        if (S.viewer.open) return closeViewer();
        if (S.selection.size) { S.selection.clear(); updateSelectionBar(); updateSelectionClasses(); }
        return;
      }
      if (typing) return;
      if (e.key === 'ArrowLeft' && S.viewer.open) { e.preventDefault(); navigateViewer(-1); }
      if (e.key === 'ArrowRight' && S.viewer.open) { e.preventDefault(); navigateViewer(1); }
      if (e.key === ' ' && S.viewer.open && canPlayCurrent()) {
        const el = e.target;
        if (!(el && el.closest && el.closest('button'))) {
          e.preventDefault();
          toggleStagePlayback();
        }
      }
      if ((e.key === 'f' || e.key === 'F') && S.viewer.open) { e.preventDefault(); toggleFavorite(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        $('#btn-import').click();
      }
      if (e.key === 'Delete' && S.selection.size) {
        e.preventDefault();
        batchAction(S.view.type === 'trash' ? 'purge' : 'delete');
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !S.viewer.open) {
        e.preventDefault();
        S.filtered.forEach((i) => S.selection.add(i.id));
        updateSelectionBar();
        updateSelectionClasses();
      }
    });

    // 主进程事件
    api.on('library-changed', (data) => {
      applyState(data, { silent: true });
    });
    api.on('phone-thumb', (p) => {
      if (!p || !p.id || !p.url) return;
      applyPhoneThumb(p.id, p.url);
    });
    api.on('phone-wifi-progress', (p) => {
      if (!wifiOn) return;
      appendWifiLog(p);
    });
    api.on('similar-progress', (p) => {
      const el = $('#similar-body .sim-status');
      if (el && p && p.total) el.textContent = `正在分析照片指纹… ${p.done}/${p.total}`;
    });
    api.on('phone-thumb-status', (p) => {
      if (!p || !phoneGroups.length || phoneBusy) return;
      const el = $('#phone-detect-state');
      if (!el || !el.classList.contains('on')) return;
      el.innerHTML = `<span class="dot-on"></span>已检测到设备，共 ${phoneGroups.length} 项 · 正在生成预览`;
    });
    api.on('phone-thumb-done', (p) => {
      if (!p || !phoneGroups.length || phoneBusy) return;
      const el = $('#phone-detect-state');
      if (!el || !el.classList.contains('on')) return;
      const shown = p.thumbs || 0;
      el.innerHTML = shown
        ? `<span class="dot-on"></span>已检测到设备，共 ${phoneGroups.length} 项`
        : `<span class="dot-on"></span>已检测到设备，共 ${phoneGroups.length} 项（预览不可用）`;
    });
    api.on('storage-state', (payload) => {
      if (!S.app) return;
      S.app.available = payload.available;
      S.storageOk = payload.available;
      if (payload.available) {
        updateStorageBanner();
        toast(payload.message || '存储介质已恢复', 'success');
        refreshState();
      } else {
        showStorageBanner(false);
        toast(payload.message || '存储位置不可用，已切换只读模式', 'error');
      }
    });
  }

  // ---------------- 中键滚动（与浏览器原生中键滚动行为一致） ----------------
  // 占位说明：若运行环境不支持鼠标中键事件（mousedown/auxclick 的 button === 1），
  // 等效替代触发方式为「按住 Alt + 左键上下拖动」。此处仅作占位说明，不引入额外实现或依赖。
  function bindMiddleScroll() {
    const vp = $viewport();
    let active = false;
    let sticky = false;    // 快速点击中键后进入的粘滞模式（再次点击任意键退出）
    let originY = 0;
    let dy = 0;
    let moved = 0;
    let downAt = 0;
    let rafId = 0;
    let marker = null;
    const DEAD_ZONE = 8;   // 原点死区（px），避免轻微抖动即滚动
    const MAX_STEP = 30;   // 每帧最大滚动距离（px）

    const speedFor = (delta) => {
      const d = Math.abs(delta) - DEAD_ZONE;
      if (d <= 0) return 0;
      return Math.sign(delta) * Math.min(MAX_STEP, d * 0.12);
    };
    const step = () => {
      if (!active) return;
      vp.scrollTop += speedFor(dy);
      rafId = requestAnimationFrame(step);
    };
    const onMove = (e) => {
      dy = e.clientY - originY;
      moved = Math.max(moved, Math.abs(dy));
    };
    const onUp = (e) => {
      if (e.button !== 1 || !active) return;
      // 浏览器原生行为：快速点按（按住时间短且几乎未移动）→ 进入粘滞模式
      if (!sticky && Date.now() - downAt < 250 && moved < 6) { sticky = true; return; }
      exit();
    };
    const onAnyDown = (e) => {
      if (active && sticky && e.button !== 1) exit(); // 粘滞模式下点击左/右键退出
    };
    function exit() {
      if (!active) return;
      active = false;
      sticky = false;
      cancelAnimationFrame(rafId);
      vp.classList.remove('mid-scroll');
      if (marker) { marker.remove(); marker = null; }
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('mousedown', onAnyDown, true);
    }

    vp.addEventListener('mousedown', (e) => {
      if (e.button !== 1) return; // 左键/右键交互完全不受影响
      e.preventDefault();
      e.stopPropagation();
      if (active) { exit(); return; }
      stopHover();
      active = true;
      sticky = false;
      originY = e.clientY;
      dy = 0;
      moved = 0;
      downAt = Date.now();
      vp.classList.add('mid-scroll');
      // 原点标记（浏览器原生中键滚动的圆形图标）
      marker = document.createElement('div');
      marker.className = 'mid-scroll-marker';
      marker.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 3.5l4.5 4.5h-9z"/><path d="M12 20.5l-4.5-4.5h9z"/></svg>';
      marker.style.left = `${e.clientX - 13}px`;
      marker.style.top = `${e.clientY - 13}px`;
      document.body.appendChild(marker);
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      document.addEventListener('mousedown', onAnyDown, true);
      rafId = requestAnimationFrame(step);
    });
    // 阻止中键点击的默认行为（如自动滚动、打开链接）
    vp.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    // 中键滚动模式下滚动滚轮 / 按 Esc / 窗口失焦时退出，回归普通滚动
    vp.addEventListener('wheel', () => { if (active) exit(); }, { passive: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') exit(); });
    window.addEventListener('blur', exit);
  }

  // ---------------- 启动 ----------------
  async function init() {
    bind();
    bindGridEvents();
    bindMiddleScroll();
    try {
      const data = await call(api.state);
      applyState(data);
    } catch (e) {
      toast('初始化失败：' + e.message, 'error');
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
