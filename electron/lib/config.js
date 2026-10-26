'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson, readJson } = require('./util');

const DEFAULTS = {
  storageRoot: null,
  libraryId: null,
  window: { width: 1440, height: 920, x: null, y: null, maximized: false },
  ui: { tileSize: 210, theme: 'dark' },
};

class Config {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.file = path.join(userDataDir, 'config.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        ...DEFAULTS,
        ...raw,
        window: { ...DEFAULTS.window, ...(raw.window || {}) },
        ui: { ...DEFAULTS.ui, ...(raw.ui || {}) },
      };
    } catch {
      this.data = JSON.parse(JSON.stringify(DEFAULTS));
    }
    return this.data;
  }

  get all() {
    return this.data;
  }

  async update(patch) {
    this.data = { ...this.data, ...patch };
    await atomicWriteJson(this.file, this.data);
    return this.data;
  }

  /** 退出前使用：同步写入，避免异步队列未完成 */
  updateSync(patch) {
    this.data = { ...this.data, ...patch };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8');
    } catch {}
    return this.data;
  }
}

module.exports = { Config, DEFAULTS };
