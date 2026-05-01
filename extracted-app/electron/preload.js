const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  startMonitoring: () => ipcRenderer.invoke('start-monitoring'),
  stopMonitoring: () => ipcRenderer.invoke('stop-monitoring'),
  getNetworkStatus: () => ipcRenderer.invoke('get-network-status'),

  getLiveStats: () => ipcRenderer.invoke('get-live-stats'),
  getAlerts: () => ipcRenderer.invoke('get-alerts'),
  getEvents: () => ipcRenderer.invoke('get-events'),

  simulateAttack: (attackType) => ipcRenderer.invoke('simulate-attack', attackType),
  blockIp: (ip) => ipcRenderer.invoke('block-ip', ip),

  scanHardware: () => ipcRenderer.invoke('scan-hardware'),

  exportReport: () => ipcRenderer.invoke('export-report'),
  saveReport: (data) => ipcRenderer.invoke('save-report', data),
  loadReport: () => ipcRenderer.invoke('load-report'),

  minimize: () => ipcRenderer.invoke('minimize-window'),
  maximize: () => ipcRenderer.invoke('maximize-window'),
  close: () => ipcRenderer.invoke('close-window'),

  onUpdateStatus: (callback) => {
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },

  onNetworkStatusChange: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('network-status-change', handler);
    return () => ipcRenderer.removeListener('network-status-change', handler);
  },

  onHardwareScanComplete: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('hardware-scan-complete', handler);
    return () => ipcRenderer.removeListener('hardware-scan-complete', handler);
  }
});