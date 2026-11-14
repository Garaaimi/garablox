'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Единственный мост между UI и системой. Ничего лишнего наружу не отдаём. */
contextBridge.exposeInMainWorld('garablox', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveState: (patch) => ipcRenderer.invoke('state:save', patch),
  resetState: () => ipcRenderer.invoke('state:reset'),

  lookupGame: (input) => ipcRenderer.invoke('game:lookup', input),
  addGame: (input) => ipcRenderer.invoke('game:add', input),
  refreshGame: (placeId) => ipcRenderer.invoke('game:refresh', placeId),
  removeGame: (placeId) => ipcRenderer.invoke('game:remove', placeId),
  featureGame: (placeId) => ipcRenderer.invoke('game:feature', placeId),
  launchGame: (placeId) => ipcRenderer.invoke('game:launch', placeId),
  openGamePage: (placeId) => ipcRenderer.invoke('game:openPage', placeId),

  detectClients: () => ipcRenderer.invoke('clients:detect'),
  pickClient: () => ipcRenderer.invoke('client:pick'),
  installRoblox: () => ipcRenderer.invoke('roblox:install'),

  searchGames: (query, pageToken) => ipcRenderer.invoke('catalog:search', query, pageToken),
  getRecommendations: (sortId) => ipcRenderer.invoke('catalog:recommendations', sortId),
  getSorts: () => ipcRenderer.invoke('catalog:sorts'),

  addFriend: (username) => ipcRenderer.invoke('friends:add', username),
  removeFriend: (id) => ipcRenderer.invoke('friends:remove', id),
  refreshFriends: () => ipcRenderer.invoke('friends:refresh'),

  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openRobloxApp: () => ipcRenderer.invoke('app:openRobloxApp'),
  openStateFolder: () => ipcRenderer.invoke('app:statePath'),
  openLog: () => ipcRenderer.invoke('app:openLog'),

  minimize: () => ipcRenderer.invoke('win:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
  close: () => ipcRenderer.invoke('win:close'),

  onInstallProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('install:progress', handler);
    return () => ipcRenderer.removeListener('install:progress', handler);
  },

  onMaximized: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('win:maximized', handler);
    return () => ipcRenderer.removeListener('win:maximized', handler);
  }
});
