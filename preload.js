const { desktopCapturer, ipcRenderer } = require('electron');

// Since contextIsolation is false, we can directly attach to window
window.electronAPI = {
  getDesktopSources: (opts) => desktopCapturer.getSources(opts),
  ipcRenderer: ipcRenderer
};

console.log('Preload script loaded, electronAPI attached to window');