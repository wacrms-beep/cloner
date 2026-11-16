/**
 * Script Preload Electron : expose l'API sécurisée window.api via contextBridge
 * avec une liste blanche stricte de canaux IPC.
 */
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_INVOKE_CHANNELS = Object.freeze([
  'legal:status',
  'legal:accept',
  'license:status',
  'license:activate',
  'modules:list',
  'settings:get',
  'settings:update',
  'settings:testPython',
  'settings:pickDirectory',
  'engine:status',
  'engine:ping',
  'clone:start',
  'clone:pause',
  'clone:resume',
  'clone:cancel',
  'clone:get',
  'clone:list',
  'clone:logs',
  'clone:delete',
  'clone:openFolder',
  'clone:openZip',
  'clone:preview',
  'studio:openDb',
  'studio:listTables',
  'studio:describe',
  'studio:rows',
  'studio:updateCell',
  'studio:insertRow',
  'studio:deleteRow',
  'studio:runSql',
  'studio:export',
  'studio:import',
  'gmail:connect',
  'gmail:disconnect',
  'gmail:status',
  'auth:acquire',
  'auth:resume',
  'auth:cancel',
  'auth:listAccounts',
  'auth:revealPassword',
  'auth:deleteAccount',
  'auth:listSessions',
  'auth:deleteSession',
  'cookies:import',
  'cookies:parse',
  'cookies:list',
  'cookies:edit',
  'cookies:test'
]);

const ALLOWED_EVENT_CHANNELS = Object.freeze([
  'engine:event'
]);

contextBridge.exposeInMainWorld('api', {
  /**
   * Appelle un canal IPC autorisé en liste blanche.
   * @param {string} channel Nom du canal
   * @param {object} [payload] Arguments
   */
  invoke(channel, payload = {}) {
    if (!ALLOWED_INVOKE_CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`Canal IPC non autorisé : ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },

  /**
   * S'abonne à un canal d'événements temps réel autorisé.
   * @param {string} channel Nom du canal
   * @param {Function} callback Fonction (payload) => void
   * @returns {Function} Fonction de désabonnement
   */
  on(channel, callback) {
    if (!ALLOWED_EVENT_CHANNELS.includes(channel) || typeof callback !== 'function') {
      throw new Error(`Canal d'événement non autorisé : ${channel}`);
    }
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
