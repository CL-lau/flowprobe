const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld(
  'flowprobe',
  Object.freeze({
    command: (command) => ipcRenderer.invoke('flowprobe:command', command),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('flowprobe:state', listener);
      return () => ipcRenderer.removeListener('flowprobe:state', listener);
    },
  }),
);
