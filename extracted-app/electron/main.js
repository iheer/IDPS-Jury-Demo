const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');

let isDev = false;
try {
  isDev = require('electron-is-dev');
} catch {
  isDev = !app.isPackaged;
}

const execAsync = promisify(exec);

let mainWindow = null;
let pythonProcess = null;
let backendReady = false;
const BACKEND_PORT = 5000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const logFile = path.join(__dirname, 'electron.log');

const log = (...args) => {
  const message =
    args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ') + '\n';
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} - ${message}`);
  } catch {}
  console.log(...args);
};

process.on('uncaughtException', (error) => {
  log('Uncaught Exception:', error?.message || error);
  if (error?.stack) log(error.stack);
});

process.on('unhandledRejection', (error) => {
  log('Unhandled Rejection:', error?.message || error);
  if (error?.stack) log(error.stack);
});

async function apiGet(endpoint) {
  const res = await fetch(`${BACKEND_URL}${endpoint}`);
  if (!res.ok) {
    throw new Error(`GET ${endpoint} failed with status ${res.status}`);
  }
  return res.json();
}

async function apiPost(endpoint, body = {}) {
  const res = await fetch(`${BACKEND_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${endpoint} failed with status ${res.status}`);
  }
  return res.json();
}

async function waitForBackend(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await apiGet('/health');
      backendReady = true;
      log('Backend is ready');
      return true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 700));
    }
  }
  backendReady = false;
  return false;
}

function getPythonCommand() {
  if (process.platform === 'win32') {
    return ['python', 'py', 'python3'];
  }
  return ['python3', 'python'];
}

function getBackendScriptPath() {
  const candidates = [
    path.join(__dirname, 'backend', 'app.py'),
    path.join(process.cwd(), 'backend', 'app.py'),
    path.join(__dirname, '..', 'backend', 'app.py'),
  ];
  return candidates.find(p => fs.existsSync(p));
}

async function startPythonBackend() {
  if (pythonProcess) {
    log('Python backend already running');
    return { success: true, alreadyRunning: true };
  }

  const backendScript = getBackendScriptPath();
  if (!backendScript) {
    log('Backend script not found');
    return { success: false, error: 'backend/app.py not found' };
  }

  const commands = getPythonCommand();
  let started = false;
  let lastError = null;

  for (const cmd of commands) {
    try {
      log(`Trying to start backend with: ${cmd} ${backendScript}`);

      pythonProcess = spawn(cmd, [backendScript], {
        cwd: path.dirname(backendScript),
        env: { ...process.env, PYTHONUNBUFFERED: '1', PORT: String(BACKEND_PORT) },
        shell: false,
        windowsHide: true,
      });

      pythonProcess.stdout?.on('data', (data) => {
        log(`[PYTHON STDOUT] ${data.toString().trim()}`);
      });

      pythonProcess.stderr?.on('data', (data) => {
        log(`[PYTHON STDERR] ${data.toString().trim()}`);
      });

      pythonProcess.on('close', (code) => {
        log(`Python backend exited with code ${code}`);
        pythonProcess = null;
        backendReady = false;
      });

      pythonProcess.on('error', (err) => {
        log(`Python process error with ${cmd}:`, err.message);
      });

      const ready = await waitForBackend();
      if (ready) {
        started = true;
        break;
      } else {
        lastError = `Backend did not become ready using ${cmd}`;
        try { pythonProcess.kill(); } catch {}
        pythonProcess = null;
      }
    } catch (err) {
      lastError = err.message;
      log(`Failed to start backend with ${cmd}:`, err.message);
      pythonProcess = null;
    }
  }

  if (!started) {
    return { success: false, error: lastError || 'Could not start Python backend' };
  }

  return { success: true };
}

function stopPythonBackend() {
  if (pythonProcess) {
    try {
      pythonProcess.kill();
      log('Python backend stopped');
    } catch (err) {
      log('Error stopping Python backend:', err.message);
    }
    pythonProcess = null;
  }
  backendReady = false;
}

function configureSession() {
  const { session } = require('electron');
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    log('Permission requested:', permission);
    callback(true);
  });
}

function getIndexPath() {
  const candidates = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'dist', 'index.html'),
    path.join(process.resourcesPath, 'app.asar', 'dist', 'index.html'),
    path.join(process.resourcesPath, 'app.asar/dist/index.html'),
    path.join(__dirname, '../dist/index.html'),
  ];
  return candidates.find(p => fs.existsSync(p));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173').catch(err => {
      log('Failed to load Vite dev server:', err.message);
    });
  } else {
    const indexPath = getIndexPath();
    if (!indexPath) {
      log('No index.html found for production');
      dialog.showErrorBox('Startup Error', 'Could not find index.html for the application.');
      return;
    }
    log('Loading index file:', indexPath);
    mainWindow.loadFile(indexPath).catch(err => {
      log('Failed to load production build:', err.message);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('start-monitoring', async () => {
  try {
    const backend = await startPythonBackend();
    if (!backend.success) return backend;
    const result = await apiPost('/monitoring/start');
    return { success: true, ...result };
  } catch (error) {
    log('Error in start-monitoring:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-monitoring', async () => {
  try {
    const result = await apiPost('/monitoring/stop');
    return { success: true, ...result };
  } catch (error) {
    log('Error in stop-monitoring:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-network-status', async () => {
  try {
    if (!backendReady) {
      return { status: 'disconnected', backendReady: false };
    }
    const result = await apiGet('/status');
    return { ...result, backendReady: true };
  } catch (error) {
    return { status: 'disconnected', backendReady: false, error: error.message };
  }
});

ipcMain.handle('get-live-stats', async () => {
  try {
    return await apiGet('/stats');
  } catch (error) {
    log('Error in get-live-stats:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-alerts', async () => {
  try {
    return await apiGet('/alerts');
  } catch (error) {
    log('Error in get-alerts:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-events', async () => {
  try {
    return await apiGet('/events');
  } catch (error) {
    log('Error in get-events:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('simulate-attack', async (_, attackType) => {
  try {
    return await apiPost('/simulate', { attack_type: attackType });
  } catch (error) {
    log('Error in simulate-attack:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('block-ip', async (_, ip) => {
  try {
    return await apiPost('/block-ip', { ip });
  } catch (error) {
    log('Error in block-ip:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('export-report', async () => {
  try {
    const report = await apiGet('/report');
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save IDPS Report',
      defaultPath: `idps-report-${Date.now()}.json`,
      filters: [
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ],
    });

    if (canceled || !filePath) {
      return { success: false, canceled: true };
    }

    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
    return { success: true, filePath };
  } catch (error) {
    log('Error in export-report:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('scan-hardware', async () => {
  try {
    const { stdout: usbDevices } = await execAsync('wmic path Win32_USBHub get DeviceID,Name,Status /format:csv');
    const usbList = usbDevices.split('\n')
      .filter(line => line.includes('USB\\'))
      .map(line => {
        const [_, id, name, status] = line.split(',');
        return {
          id: id ? id.trim() : '',
          name: name ? name.trim() : '',
          type: 'USB',
          status: status && status.trim().toLowerCase() === 'ok' ? 'connected' : 'disconnected',
          lastSeen: new Date().toISOString(),
          details: {
            vendor: name ? name.split('\\')[0].trim() : ''
          }
        };
      });

    const { stdout: diskDrives } = await execAsync('wmic diskdrive get DeviceID,Model,Size,Status /format:csv');
    const diskList = diskDrives.split('\n')
      .filter(line => line.includes('\\\\.\\'))
      .map(line => {
        const [_, id, model, size, status] = line.split(',');
        return {
          id: id ? id.trim() : '',
          name: model ? model.trim() : '',
          type: 'Disk',
          status: status && status.trim().toLowerCase() === 'ok' ? 'connected' : 'disconnected',
          lastSeen: new Date().toISOString(),
          details: {
            capacity: size ? size.trim() : '',
            vendor: model ? model.split(' ')[0].trim() : ''
          }
        };
      });

    const allDevices = [...usbList, ...diskList];
    const analyzedDevices = allDevices.map(device => {
      const nm = (device.name || '').toLowerCase();
      const vendor = (device.details.vendor || '').toLowerCase();
      const isSuspicious =
        nm.includes('unknown') ||
        vendor.includes('unknown') ||
        (device.type === 'USB' && nm.includes('mass storage')) ||
        (device.type === 'Disk' && !device.details.capacity);

      return {
        ...device,
        status: isSuspicious ? 'suspicious' : device.status
      };
    });

    return { success: true, devices: analyzedDevices };
  } catch (error) {
    log('Error in scan-hardware:', error.message);
    return { success: false, error: error.message, devices: [] };
  }
});

ipcMain.handle('save-report', async (_, data) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save Report',
      defaultPath: `report-${Date.now()}.json`,
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
    });

    if (canceled || !filePath) {
      return { success: false, canceled: true };
    }

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true, filePath };
  } catch (error) {
    log('Error in save-report:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('load-report', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Load Report',
      properties: ['openFile'],
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
    });

    if (canceled || !filePaths?.length) {
      return { success: false, canceled: true };
    }

    const raw = fs.readFileSync(filePaths[0], 'utf-8');
    return { success: true, data: JSON.parse(raw), filePath: filePaths[0] };
  } catch (error) {
    log('Error in load-report:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('minimize-window', () => {
  BrowserWindow.getFocusedWindow()?.minimize();
  return { success: true };
});

ipcMain.handle('maximize-window', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win?.isMaximized()) {
    win.unmaximize();
  } else {
    win?.maximize();
  }
  return { success: true };
});

ipcMain.handle('close-window', () => {
  BrowserWindow.getFocusedWindow()?.close();
  return { success: true };
});

app.whenReady().then(async () => {
  log('App is ready');
  configureSession();

  if (!isDev) {
    const backendResult = await startPythonBackend();
    log('Backend startup result:', backendResult);
  }

  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  log('All windows closed');
  stopPythonBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopPythonBackend();
});