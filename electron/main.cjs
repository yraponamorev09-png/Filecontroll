const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

let mainWindow;
let isDev = false;

function sendMenuAction(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu-action', action);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
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

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist-web', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
