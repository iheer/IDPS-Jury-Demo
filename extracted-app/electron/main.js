const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');

// Force production mode — load from dist/, not Vite dev server
const isDev = false;

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
  if (!res.ok) throw new Error(`GET ${endpoint} failed with status ${res.status}`);
  return res.json();
}

async function apiPost(endpoint, body = {}) {
  const res = await fetch(`${BACKEND_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${endpoint} failed with status ${res.status}`);
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
  return process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
}

function getBackendScriptPath() {
  // __dirname = extracted-app/electron/
  // backend/  = project root (two levels up from __dirname)
  const candidates = [
    path.join(__dirname, '..', '..', 'backend', 'app.py'),   // IDPS-Jury-Demo/backend/app.py
    path.join(__dirname, '..', 'backend', 'app.py'),          // extracted-app/backend/app.py
    path.join(process.cwd(), '..', 'backend', 'app.py'),      // cwd/../backend/app.py
    path.join(process.cwd(), 'backend', 'app.py'),             // cwd/backend/app.py
  ];
  log('Checking backend candidates:');
  candidates.forEach(p => log(' -', p, fs.existsSync(p) ? 'FOUND' : 'not found'));
  return candidates.find(p => fs.existsSync(p));
}

async function startPythonBackend() {
  if (pythonProcess) {
    log('Python backend already running');
    return { success: true, alreadyRunning: true };
  }

  const backendScript = getBackendScriptPath();
  if (!backendScript) {
    log('Backend script not found in any candidate path');
    return { success: false, error: 'backend/app.py not found' };
  }

  const commands = getPythonCommand();
  let started = false;
  let lastError = null;

  for (const cmd of commands) {
    try {
      log(`Trying: ${cmd} ${backendScript}`);
      pythonProcess = spawn(cmd, [backendScript], {
        cwd: path.dirname(backendScript),
        env: { ...process.env, PYTHONUNBUFFERED: '1', PORT: String(BACKEND_PORT) },
        shell: false,
        windowsHide: true,
      });

      pythonProcess.stdout?.on('data', d => log(`[PY] ${d.toString().trim()}`));
      pythonProcess.stderr?.on('data', d => log(`[PY ERR] ${d.toString().trim()}`));
      pythonProcess.on('close', code => {
        log(`Python exited with code ${code}`);
        pythonProcess = null;
        backendReady = false;
      });
      pythonProcess.on('error', err => log(`Python spawn error (${cmd}):`, err.message));

      const ready = await waitForBackend();
      if (ready) { started = true; break; }

      lastError = `Backend not ready using ${cmd}`;
      try { pythonProcess.kill(); } catch {}
      pythonProcess = null;
    } catch (err) {
      lastError = err.message;
      pythonProcess = null;
    }
  }

  return started ? { success: true } : { success: false, error: lastError || 'Could not start Python backend' };
}

function stopPythonBackend() {
  if (pythonProcess) {
    try { pythonProcess.kill(); } catch {}
    pythonProcess = null;
  }
  backendReady = false;
}

function configureSession() {
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });
}

function getIndexPath() {
  // __dirname = extracted-app/electron/
  // dist/     = extracted-app/dist/  (one level up)
  const candidates = [
    path.join(__dirname, '..', 'dist', 'index.html'),   // extracted-app/dist/index.html  ← CORRECT
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'dist', 'index.html'),
  ];
  log('Checking index candidates:');
  candidates.forEach(p => log(' -', p, fs.existsSync(p) ? 'FOUND' : 'not found'));
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

  mainWindow.once('ready-to-show', () => mainWindow.show());

  const indexPath = getIndexPath();
  if (!indexPath) {
    log('No index.html found');
    dialog.showErrorBox('Startup Error', 'Could not find dist/index.html. Make sure the app is built.');
    return;
  }
  log('Loading:', indexPath);
  mainWindow.loadFile(indexPath).catch(err => log('Failed to load file:', err.message));

  mainWindow.on('closed', () => { mainWindow = null; });
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
    return await apiPost('/monitoring/stop');
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-network-status', async () => {
  try {
    if (!backendReady) return { status: 'disconnected', backendReady: false };
    const result = await apiGet('/status');
    return { ...result, backendReady: true };
  } catch (error) {
    return { status: 'disconnected', backendReady: false, error: error.message };
  }
});

ipcMain.handle('get-live-stats', async () => {
  try { return await apiGet('/stats'); }
  catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('get-alerts', async () => {
  try { return await apiGet('/alerts'); }
  catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('get-events', async () => {
  try { return await apiGet('/events'); }
  catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('simulate-attack', async (_, attackType) => {
  try { return await apiPost('/simulate', { attack_type: attackType }); }
  catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('block-ip', async (_, ip) => {
  try { return await apiPost('/block-ip', { ip }); }
  catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('export-report', async () => {
  try {
    const report = await apiGet('/report');
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save IDPS Report',
      defaultPath: `idps-report-${Date.now()}.json`,
      filters: [{ name: 'JSON Files', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (canceled || !filePath) return { success: false, canceled: true };
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
    return { success: true, filePath };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('scan-hardware', async () => {
  try {
    const { stdout: usbDevices } = await execAsync('wmic path Win32_USBHub get DeviceID,Name,Status /format:csv');
    const usbList = usbDevices.split('\n')
      .filter(line => line.includes('USB\\'))
      .map(line => {
        const [_, id, name, status] = line.split(',');
        return { id: id?.trim() || '', name: name?.trim() || '', type: 'USB', status: status?.trim().toLowerCase() === 'ok' ? 'connected' : 'disconnected', lastSeen: new Date().toISOString(), details: { vendor: name?.split('\\')[0]?.trim() || '' } };
      });
    const { stdout: diskDrives } = await execAsync('wmic diskdrive get DeviceID,Model,Size,Status /format:csv');
    const diskList = diskDrives.split('\n')
      .filter(line => line.includes('\\\\.\\'))
      .map(line => {
        const [_, id, model, size, status] = line.split(',');
        return { id: id?.trim() || '', name: model?.trim() || '', type: 'Disk', status: status?.trim().toLowerCase() === 'ok' ? 'connected' : 'disconnected', lastSeen: new Date().toISOString(), details: { capacity: size?.trim() || '', vendor: model?.split(' ')[0]?.trim() || '' } };
      });
    const analyzedDevices = [...usbList, ...diskList].map(device => {
      const nm = device.name.toLowerCase();
      const isSuspicious = nm.includes('unknown') || (device.type === 'USB' && nm.includes('mass storage')) || (device.type === 'Disk' && !device.details.capacity);
      return { ...device, status: isSuspicious ? 'suspicious' : device.status };
    });
    return { success: true, devices: analyzedDevices };
  } catch (error) { return { success: false, error: error.message, devices: [] }; }
});

ipcMain.handle('save-report', async (_, data) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog({ title: 'Save Report', defaultPath: `report-${Date.now()}.json`, filters: [{ name: 'JSON Files', extensions: ['json'] }] });
    if (canceled || !filePath) return { success: false, canceled: true };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true, filePath };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('load-report', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({ title: 'Load Report', properties: ['openFile'], filters: [{ name: 'JSON Files', extensions: ['json'] }] });
    if (canceled || !filePaths?.length) return { success: false, canceled: true };
    const raw = fs.readFileSync(filePaths[0], 'utf-8');
    return { success: true, data: JSON.parse(raw), filePath: filePaths[0] };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('minimize-window', () => { BrowserWindow.getFocusedWindow()?.minimize(); return { success: true }; });
ipcMain.handle('maximize-window', () => { const w = BrowserWindow.getFocusedWindow(); w?.isMaximized() ? w.unmaximize() : w?.maximize(); return { success: true }; });
ipcMain.handle('close-window', () => { BrowserWindow.getFocusedWindow()?.close(); return { success: true }; });

app.whenReady().then(async () => {
  log('App is ready');
  configureSession();

  // Try to start backend automatically (if not already running externally)
  const backendResult = await startPythonBackend();
  log('Backend startup result:', JSON.stringify(backendResult));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopPythonBackend();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => stopPythonBackend());
