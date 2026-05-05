const { app, BrowserWindow, Menu, shell } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow;
let isDev = false;
let windowState = { width: 1400, height: 900, x: undefined, y: undefined, maximized: false };
const windowStatePath = () => path.join(app.getPath('userData'), 'window-state.json');
const previewPort = 4173;
let previewServer = null;

function readWindowState() {
  try {
    const raw = fs.readFileSync(windowStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      windowState = {
        width: Number.isFinite(parsed.width) ? parsed.width : 1400,
        height: Number.isFinite(parsed.height) ? parsed.height : 900,
        x: Number.isFinite(parsed.x) ? parsed.x : undefined,
        y: Number.isFinite(parsed.y) ? parsed.y : undefined,
        maximized: !!parsed.maximized,
      };
    }
  } catch {
    windowState = { width: 1400, height: 900, x: undefined, y: undefined, maximized: false };
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const payload = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: mainWindow.isMaximized(),
  };
  try {
    fs.writeFileSync(windowStatePath(), JSON.stringify(payload, null, 2));
  } catch {
    // Ignore persistence failures; startup should still work.
  }
}

function sendMenuAction(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu-action', action);
  }
}

function servePreviewFile(rootDir, req, res) {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = path.join(rootDir, urlPath === '/' ? 'index.html' : urlPath);
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!fs.existsSync(filePath)) {
      filePath = path.join(rootDir, 'index.html');
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.map': 'application/json; charset=utf-8',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(err?.message || err));
  }
}

async function startPreviewServer() {
  if (previewServer) return previewServer;
  const rootDir = path.join(__dirname, '..', 'dist-web');
  previewServer = http.createServer((req, res) => servePreviewFile(rootDir, req, res));
  await new Promise((resolve, reject) => {
    previewServer.once('error', reject);
    previewServer.listen(previewPort, '127.0.0.1', resolve);
  });
  return previewServer;
}

function createWindow() {
  readWindowState();
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    minWidth: 800,
    minHeight: 600,
    x: windowState.x,
    y: windowState.y,
    title: 'Vault DMS',
    show: false,
    backgroundColor: '#0a0b10',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    titleBarStyle: 'default',
  });

  isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

  const previewUrl = `http://127.0.0.1:${previewPort}/`;
  mainWindow.loadURL(previewUrl);
  if (isDev) mainWindow.webContents.openDevTools();

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow.isDestroyed()) {
      if (windowState.maximized) mainWindow.maximize();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);
  mainWindow.on('maximize', saveWindowState);
  mainWindow.on('unmaximize', saveWindowState);
  mainWindow.on('close', saveWindowState);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Upload file', accelerator: 'Ctrl+O', click: () => sendMenuAction('upload') },
        { label: 'New folder', accelerator: 'Ctrl+Shift+N', click: () => sendMenuAction('new-folder') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select all' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Reload', accelerator: 'Ctrl+R' },
        { role: 'forceReload', label: 'Force reload', accelerator: 'Ctrl+Shift+R' },
        { role: 'toggleDevTools', label: 'Developer tools', accelerator: 'F12' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Reset zoom' },
        { role: 'zoomIn', label: 'Zoom in' },
        { role: 'zoomOut', label: 'Zoom out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Fullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Vault DMS',
          click: () => {
            const { dialog } = require('electron');
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Vault DMS',
              message: 'Vault DMS v1.0.0',
              detail: 'Document management system with encryption, versioning, and collaboration.',
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(async () => {
  await startPreviewServer();
  createWindow();
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (previewServer) {
    try { previewServer.close(); } catch {}
    previewServer = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
