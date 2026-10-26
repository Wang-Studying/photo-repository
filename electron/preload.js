'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CHANNELS = new Set([
  'import-progress',
  'rescan-progress',
  'migrate-progress',
  'library-changed',
  'storage-state',
  'phone-thumb',
  'phone-thumb-status',
  'phone-thumb-done',
  'phone-wifi-progress',
  'similar-progress',
]);

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  state: () => invoke('app:state'),
  pickRoot: () => invoke('app:pick-root'),
  useRoot: (root) => invoke('app:use-root', root),
  locateRoot: () => invoke('app:locate-root'),
  openRoot: () => invoke('app:open-root'),
  revealItem: (id) => invoke('app:reveal-item', id),
  openExternal: (url) => invoke('app:open-external', url),
  setUi: (patch) => invoke('app:set-ui', patch),

  importDialog: (mode) => invoke('library:import-dialog', mode),
  importPaths: (paths) => invoke('library:import-paths', paths),
  rescan: () => invoke('library:rescan'),
  updateItem: (id, patch) => invoke('library:update-item', id, patch),
  itemExif: (id) => invoke('library:item-exif', id),
  deleteItems: (ids) => invoke('library:delete-items', ids),
  restoreItems: (ids) => invoke('library:restore-items', ids),
  purgeItems: (ids) => invoke('library:purge-items', ids),
  emptyTrash: () => invoke('library:empty-trash'),
  createAlbum: (name) => invoke('library:create-album', name),
  renameAlbum: (id, name) => invoke('library:rename-album', id, name),
  deleteAlbum: (id) => invoke('library:delete-album', id),
  addToAlbum: (ids, albumId) => invoke('library:add-to-album', ids, albumId),
  removeFromAlbum: (ids, albumId) => invoke('library:remove-from-album', ids, albumId),
  saveCrop: (id, crop) => invoke('library:save-crop', id, crop),
  exportCrop: (id, crop) => invoke('library:export-crop', id, crop),
  exportItems: (ids) => invoke('library:export-items', ids),
  verifyItem: (id) => invoke('library:verify-item', id),
  clearCache: () => invoke('library:clear-cache'),
  migrate: () => invoke('library:migrate'),
  stats: () => invoke('library:stats'),
  findSimilar: () => invoke('library:find-similar'),

  phone: {
    detect: () => invoke('phone:detect'),
    list: () => invoke('phone:list'),
    thumbs: (groups) => invoke('phone:thumbs', groups),
    importSelected: (rels) => invoke('phone:import', rels),
    wifiStart: (ip) => invoke('phone-wifi:start', ip),
    wifiStop: () => invoke('phone-wifi:stop'),
    wifiFirewall: () => invoke('phone-wifi:allow-firewall'),
  },

  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },

  on: (channel, callback) => {
    if (!CHANNELS.has(channel)) return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
