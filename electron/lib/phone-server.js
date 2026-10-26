'use strict';

/**
 * 手机 WiFi 导入服务：在局域网内起一个临时 HTTP 服务，
 * 手机浏览器扫码打开上传页，逐文件 PUT 原始字节到暂存区（.part 落盘、完成后改名），
 * 每收完一个文件就交给图库导入（导入侧自带 SHA-256 校验与去重）。
 */

const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const dgram = require('dgram');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_FILE = 2 * 1024 * 1024 * 1024; // 单文件上限 2GB
// 固定端口段：防火墙按端口放行后，安装版/便携版/开发模式都能命中同一条规则
const PORT_RANGE = { start: 45671, end: 45690 };
const FIREWALL_RULE = 'PhotoRepo_LAN_Import';

const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>导入到照片仓库</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #0d1117; color: #e8ebf2; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 32px 20px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 6px; }
  .sub { color: #9aa4bb; font-size: 13px; margin-bottom: 28px; }
  #pick { display: block; width: 100%; max-width: 420px; padding: 22px; border: 2px dashed #3c465c; border-radius: 16px; text-align: center; font-size: 17px; color: #b9cbff; background: rgba(124,156,255,.06); cursor: pointer; }
  #pick:active { background: rgba(124,156,255,.14); }
  #list { width: 100%; max-width: 420px; margin-top: 22px; display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; align-items: center; gap: 10px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: 10px 12px; font-size: 13px; }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st { flex-shrink: 0; font-size: 12px; color: #9aa4bb; }
  .st.done { color: #6ee7a8; } .st.dup { color: #f0c674; } .st.err { color: #ff8a8a; }
  .err-note { width: 100%; max-width: 420px; font-size: 11.5px; color: #ff8a8a; padding: 0 8px 2px; margin-top: -4px; word-break: break-all; line-height: 1.5; }
  .bar { height: 3px; background: rgba(255,255,255,.1); border-radius: 2px; overflow: hidden; margin-top: 4px; }
  .bar i { display: block; height: 100%; background: #7c9cff; width: 0; transition: width .2s; }
</style></head><body>
<h1>导入到照片仓库</h1>
<div class="sub">选择照片或视频，保持本页面打开直到全部完成</div>
<label id="pick">＋ 选择照片 / 视频<input id="file" type="file" multiple accept="image/*,video/*,.heic,.heif,.dng" style="display:none"></label>
<div id="list"></div>
<script>
const TOKEN = new URLSearchParams(location.search).get('t') || '';
const list = document.getElementById('list');
document.getElementById('file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) await upload(f);
});
async function upload(f) {
  const row = document.createElement('div'); row.className = 'row';
  const nm = document.createElement('div'); nm.className = 'name';
  nm.textContent = f.name;
  const right = document.createElement('div');
  const st = document.createElement('div'); st.className = 'st'; st.textContent = '等待';
  const barWrap = document.createElement('div'); barWrap.className = 'bar';
  const bar = document.createElement('i'); barWrap.appendChild(bar);
  right.appendChild(st); right.appendChild(barWrap);
  right.style.width = '110px';
  row.appendChild(nm); row.appendChild(right); list.prepend(row);
  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/upload?t=' + encodeURIComponent(TOKEN) + '&name=' + encodeURIComponent(f.name));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { bar.style.width = Math.round(e.loaded / e.total * 100) + '%'; st.textContent = Math.round(e.loaded / e.total * 100) + '%'; } };
      xhr.onload = () => {
        try {
          const r = JSON.parse(xhr.responseText);
          if (!xhr.status || xhr.status >= 400 || !r.ok) return reject(new Error(r.error || ('HTTP ' + xhr.status)));
          resolve(r);
        } catch (err) { reject(err); }
      };
      xhr.onerror = () => reject(new Error('网络中断'));
      xhr.send(f);
    }).then((r) => {
      st.className = 'st ' + (r.status === 'dup' ? 'dup' : 'done');
      st.textContent = r.status === 'dup' ? '已存在' : '已入库';
      bar.style.width = '100%';
    });
  } catch (err) {
    st.className = 'st err';
    st.textContent = '失败';
    nm.title = err.message;
    const note = document.createElement('div');
    note.className = 'err-note';
    note.textContent = err.message || '上传失败';
    row.insertAdjacentElement('afterend', note);
  }
}
</script></body></html>`;

class PhoneServer {
  constructor() {
    this.server = null;
    this.token = null;
    this.stagingDir = null;
    this.onFile = null;
    this.onProgress = null;
    this.url = null;
    this.port = 0;
    this.urls = [];
  }

  /**
   * 取默认路由的出口 IP：真正用来访问外网的那块网卡。
   * 比按网段猜更可靠——虚拟网卡（VMware/Hyper-V/WSL）通常是 192.168.x 或 172.x，
   * 按网段优先会误选到它们，手机因此永远连不上。UDP connect 不发包，只让系统选路。
   */
  static defaultRouteIp() {
    return new Promise((resolve) => {
      let sock;
      const finish = (ip) => {
        try { sock.close(); } catch {}
        resolve(ip || null);
      };
      try {
        sock = dgram.createSocket('udp4');
      } catch { resolve(null); return; }
      const timer = setTimeout(() => finish(null), 900);
      sock.once('error', () => { clearTimeout(timer); finish(null); });
      try {
        sock.connect(53, '8.8.8.8', () => {
          clearTimeout(timer);
          let ip = null;
          try { ip = sock.address().address; } catch {}
          finish(ip);
        });
      } catch {
        clearTimeout(timer);
        finish(null);
      }
    });
  }

  /**
   * 用系统接口查询网卡属性（不依赖网卡名称，换台电脑照样准）：
   * Get-NetAdapter 给出 Virtual / Status / PhysicalMediaType，
   * Get-NetIPConfiguration 给出 IPv4 与默认网关。
   * 脚本保持纯 ASCII——PowerShell 5 读无 BOM 的 UTF-8 中文会按 GBK 解析出错。
   */
  static async detectEndpoints() {
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;', // 否则中文网卡名会是乱码
      '$ErrorActionPreference=\'SilentlyContinue\';',
      '$list=@();',
      'Get-NetAdapter | Where-Object { $_.Status -eq \'Up\' } | ForEach-Object {',
      '  $a=$_;',
      '  $cfg=Get-NetIPConfiguration -InterfaceIndex $a.ifIndex;',
      '  $gw=$false; if ($cfg -and $cfg.IPv4DefaultGateway) { $gw=$true }',
      '  $wifi=$false; if ([string]$a.PhysicalMediaType -like \'*802.11*\') { $wifi=$true }',
      '  foreach ($ip in @($cfg.IPv4Address)) {',
      '    if (-not $ip.IPAddress) { continue }',
      '    if ($ip.IPAddress -like \'169.254.*\') { continue }',
      '    $list += [pscustomobject]@{ name=$a.Name; desc=$a.InterfaceDescription; virtual=[bool]$a.Virtual; wifi=$wifi; gateway=$gw; ip=[string]$ip.IPAddress; prefix=[int]$ip.PrefixLength }',
      '  }',
      '};',
      'ConvertTo-Json -InputObject @($list) -Compress -Depth 3',
    ].join('\n');

    const text = await new Promise((resolve) => {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 8000, maxBuffer: 1 << 20 },
        (err, stdout) => resolve(err ? '' : String(stdout || '')));
    });
    if (!text.trim()) return [];
    let parsed;
    try { parsed = JSON.parse(text); } catch { return []; }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      if (!r || !r.ip || seen.has(r.ip)) continue;
      seen.add(r.ip);
      out.push({
        ip: r.ip,
        name: r.name || '未知网卡',
        desc: r.desc || '',
        virtual: Boolean(r.virtual),
        wifi: Boolean(r.wifi),
        gateway: Boolean(r.gateway),
      });
    }
    // 虚拟网卡排除，无线（手机同处 WiFi）优先，其次有默认网关的有线网卡
    const rank = (a) => {
      if (a.virtual) return 100;
      return (a.wifi ? 0 : 10) + (a.gateway ? -1 : 0);
    };
    out.sort((x, y) => rank(x) - rank(y));
    return out;
  }

  /** 兜底：系统接口查询不可用时，用 os.networkInterfaces 粗略筛选 */
  static listLanIps() {
    const ifs = os.networkInterfaces();
    const virtualName = /(vmware|virtualbox|vbox|hyper-?v|vethernet|wsl|docker|virtual|tap|tun|tailscale|zerotier|radmin|hamachi|bluetooth|蓝牙|虚拟)/i;
    const out = [];
    for (const name of Object.keys(ifs)) {
      for (const it of ifs[name] || []) {
        if (it.family !== 'IPv4' || it.internal) continue;
        if (it.address.startsWith('169.254.')) continue;
        out.push({ ip: it.address, name, desc: '', virtual: virtualName.test(name), wifi: false, gateway: false });
      }
    }
    out.sort((x, y) => Number(x.virtual) - Number(y.virtual));
    return out;
  }

  /** 依次尝试固定端口段，全部占用时退回随机端口 */
  async _listen() {
    for (let p = PORT_RANGE.start; p <= PORT_RANGE.end; p += 1) {
      const ok = await new Promise((resolve) => {
        const onError = () => { this.server.removeListener('listening', onListening); resolve(false); };
        const onListening = () => { this.server.removeListener('error', onError); resolve(true); };
        this.server.once('error', onError);
        this.server.once('listening', onListening);
        this.server.listen(p, '0.0.0.0');
      });
      if (ok) return this.server.address().port;
      try { this.server.close(); } catch {}
    }
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '0.0.0.0', resolve);
    });
    return this.server.address().port;
  }

  /**
   * @param {object} opts
   * @param {string} opts.stagingDir 上传暂存目录
   * @param {string} [opts.ip] 指定对外暴露的网卡地址
   * @param {(absPath:string, name:string)=>Promise<'imported'|'dup'>} opts.onFile 收完一个文件后的导入回调
   * @param {(info:object)=>void} [opts.onProgress] 进度回调
   */
  async start(opts) {
    if (this.server) return this.info();
    this.stagingDir = opts.stagingDir;
    this.onFile = opts.onFile;
    this.onProgress = opts.onProgress || (() => {});
    await fsp.mkdir(this.stagingDir, { recursive: true });
    this.token = crypto.randomBytes(8).toString('hex');

    this.server = http.createServer((req, res) => this._handle(req, res));
    // 手机端弱网/慢速上传时不要过早断开
    this.server.keepAliveTimeout = 120000;
    this.server.headersTimeout = 125000;
    this.port = await this._listen();

    let candidates = [];
    try { candidates = await PhoneServer.detectEndpoints(); } catch {}
    if (!candidates.length) {
      // 系统接口查询不可用时的兜底
      const preferred = await PhoneServer.defaultRouteIp();
      candidates = PhoneServer.listLanIps();
      if (preferred) {
        candidates.sort((x, y) => Number(y.ip === preferred) - Number(x.ip === preferred));
      }
    }
    if (opts.ip) {
      const i = candidates.findIndex((c) => c.ip === opts.ip);
      if (i > 0) candidates.unshift(candidates.splice(i, 1)[0]);
    }
    this.urls = candidates.map((c) => ({
      ip: c.ip,
      name: c.name,
      desc: c.desc || '',
      virtual: c.virtual,
      wifi: c.wifi,
      url: this.urlFor(c.ip),
    }));
    if (!this.urls.length) {
      this.urls = [{ ip: '127.0.0.1', name: '本机', desc: '', virtual: false, wifi: false, url: this.urlFor('127.0.0.1') }];
    }
    this.url = this.urls[0].url;
    return this.info();
  }

  urlFor(ip) {
    return `http://${ip}:${this.port}/?t=${this.token}`;
  }

  info() {
    return this.server
      ? { ok: true, url: this.url, port: this.port, urls: this.urls }
      : { ok: false };
  }


  async stop() {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.url = null;
    await new Promise((r) => srv.close(r));
    await fsp.rm(this.stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  _json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  _handle(req, res) {
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('t') !== this.token) {
      res.writeHead(403); res.end('forbidden');
      return;
    }
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }
    if (req.method === 'POST' && u.pathname === '/upload') {
      this._upload(req, res, u).catch((e) => this._json(res, 500, { ok: false, error: e.message }));
      return;
    }
    res.writeHead(404); res.end('not found');
  }

  async _upload(req, res, u) {
    const rawName = u.searchParams.get('name') || 'file';
    const safeName = path.basename(rawName).replace(/[\\/:*?"<>|]/g, '_') || 'file';
    const size = Number(req.headers['content-length']) || 0;
    if (size > MAX_FILE) { this._json(res, 413, { ok: false, error: '文件过大' }); return; }

    // 每个文件单独一个暂存子目录：既可避免同名撞车，又不会把随机前缀写进入库后的文件名
    const tmpDir = path.join(this.stagingDir, crypto.randomBytes(6).toString('hex'));
    await fsp.mkdir(tmpDir, { recursive: true });
    const dest = path.join(tmpDir, safeName);
    const part = `${dest}.part`;
    this.onProgress({ name: safeName, size, state: 'receiving', received: 0 });

    const ws = fs.createWriteStream(part);
    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
      this.onProgress({ name: safeName, size, state: 'receiving', received });
    });
    req.pipe(ws);
    await new Promise((resolve, reject) => {
      ws.on('finish', resolve);
      ws.on('error', reject);
      req.on('error', reject);
      req.on('aborted', () => reject(new Error('上传中断')));
    });
    await fsp.rename(part, dest);

    this.onProgress({ name: safeName, size, state: 'importing', received });
    try {
      const status = await this.onFile(dest, safeName);
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      this.onProgress({ name: safeName, size, state: status === 'dup' ? 'dup' : 'done', received });
      this._json(res, 200, { ok: true, status });
    } catch (e) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      this.onProgress({ name: safeName, size, state: 'failed', message: e.message });
      this._json(res, 500, { ok: false, error: e.message });
    }
  }
}

module.exports = { PhoneServer, PORT_RANGE, FIREWALL_RULE };
