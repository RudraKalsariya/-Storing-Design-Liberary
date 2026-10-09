// The desktop app: starts the library server inside the app and shows it in a window.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, shell, ipcMain, dialog, nativeTheme } from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));

// Only one copy of the app at a time, so two windows never write the library at once.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Settings live in the app's own data folder; the library defaults to Documents/Design Library.
  process.env.DATA_DIR = app.getPath('userData');
  process.env.LIBRARY_DIR ||= path.join(app.getPath('documents'), 'Design Library');

  let mainWindow = null;
  let serverUrl = null;
  let lib = null; // { config, store }

  const inLibrary = (rel) => {
    const abs = path.resolve(lib.config.LIBRARY_DIR, rel);
    return abs.startsWith(lib.config.LIBRARY_DIR + path.sep) ? abs : null;
  };

  // Links to your own files open in their default app; web links open in your browser.
  function openOutside(target) {
    if (target.startsWith(`${serverUrl}/files/`)) {
      const abs = inLibrary(decodeURIComponent(new URL(target).pathname.slice('/files/'.length)));
      if (abs) shell.openPath(abs);
    } else if (/^https?:\/\//i.test(target)) {
      shell.openExternal(target);
    }
  }

  function createWindow() {
    const isMac = process.platform === 'darwin';
    mainWindow = new BrowserWindow({
      width: 1380,
      height: 900,
      minWidth: 720,
      minHeight: 520,
      title: 'Design Library',
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0c0c' : '#ffffff',
      ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 22 } } : {}),
      webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
    });
    mainWindow.loadURL(serverUrl);
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      openOutside(url);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(serverUrl)) {
        event.preventDefault();
        openOutside(url);
      }
    });
    mainWindow.on('closed', () => (mainWindow = null));
  }

  ipcMain.handle('library:open-folder', () => shell.openPath(lib.config.LIBRARY_DIR));

  ipcMain.handle('library:show-item', (_event, rel) => {
    const abs = inLibrary(String(rel));
    if (abs) shell.showItemInFolder(abs);
  });

  ipcMain.handle('library:choose-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose where your library lives',
      defaultPath: lib.config.LIBRARY_DIR,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return false;
    lib.config.saveSettings({ libraryDir: result.filePaths[0] });
    lib.store.flush();
    app.relaunch();
    app.exit(0);
    return true;
  });

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      const [config, store, { startServer }] = await Promise.all([
        import('../src/config.js'),
        import('../src/store.js'),
        import('../src/server.js'),
      ]);
      lib = { config, store };
      ({ url: serverUrl } = await startServer({ port: 0 }));
    } catch (err) {
      dialog.showErrorBox('Design Library could not start', String(err?.stack || err));
      app.exit(1);
      return;
    }
    createWindow();
    app.on('activate', () => !mainWindow && createWindow());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => lib?.store.flush());
}
