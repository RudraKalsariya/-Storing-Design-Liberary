// The desktop app: starts the library server inside the app and shows it in a window.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, shell, ipcMain, dialog, nativeTheme } from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));

// Only one copy of the app at a time, so two windows never write the library at once.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Settings live in the app's own data folder; the library defaults to Documents/Magpie.
  process.env.DATA_DIR = app.getPath('userData');
  carryOverFromDesignLibrary();
  process.env.LIBRARY_DIR ||= path.join(app.getPath('documents'), 'Magpie');

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
      title: 'Magpie',
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0c0c' : '#ffffff',
      // Mac: no title bar, the header is the drag area. Windows/Linux: the menu bar shows only when Alt is pressed.
      ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 22 } } : { autoHideMenuBar: true }),
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

  ipcMain.handle('app:set-theme', (_event, theme) => {
    nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
  });

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
      nativeTheme.themeSource = config.settings.theme;
      // A steady port keeps the page's origin the same between launches (so small
      // preferences it remembers survive a restart); any free port if it's taken.
      ({ url: serverUrl } = await startServer({ port: 47823, fallbackToAnyPort: true }));
    } catch (err) {
      dialog.showErrorBox('Magpie could not start', String(err?.stack || err));
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

/**
 * Magpie used to be called Design Library. Bring over its settings (API key,
 * model…) and keep using its library folder, so updating loses nothing.
 */
function carryOverFromDesignLibrary() {
  try {
    const oldSettings = path.join(app.getPath('appData'), 'design-library', 'settings.json');
    const newSettings = path.join(app.getPath('userData'), 'settings.json');
    if (!fs.existsSync(newSettings) && fs.existsSync(oldSettings)) {
      fs.mkdirSync(path.dirname(newSettings), { recursive: true });
      fs.copyFileSync(oldSettings, newSettings);
    }
    const oldLibrary = path.join(app.getPath('documents'), 'Design Library');
    const newLibrary = path.join(app.getPath('documents'), 'Magpie');
    if (!fs.existsSync(newLibrary) && fs.existsSync(path.join(oldLibrary, '.library.json'))) {
      process.env.LIBRARY_DIR ||= oldLibrary;
    }
  } catch {}
}
