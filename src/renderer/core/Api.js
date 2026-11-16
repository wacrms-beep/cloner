/**
 * Wrapper typé autour de window.api (contextBridge preload).
 */
export const Api = {
  invoke(channel, payload = {}) {
    if (!window.api || typeof window.api.invoke !== 'function') {
      return Promise.reject(new Error('Passerelle IPC window.api non disponible'));
    }
    return window.api.invoke(channel, payload);
  },

  onEngineEvent(callback) {
    if (!window.api || typeof window.api.on !== 'function') {
      return () => {};
    }
    return window.api.on('engine:event', callback);
  }
};
