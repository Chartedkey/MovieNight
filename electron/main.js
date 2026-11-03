'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, net, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { Service } = require('../src/service');
const { createTmdb } = require('../src/tmdb');

let win;
let service;

// Журнал ошибок рядом с данными: по нему можно понять, что случилось на компьютере пользователя.
function logLine(text) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'movie-night.log'), `${new Date().toISOString()} ${text}\n`);
  } catch (e) { /* журнал не должен мешать работе */ }
}
process.on('uncaughtException', (e) => logLine(`main: ${e.stack || e}`));
process.on('unhandledRejection', (e) => logLine(`main: ${(e && e.stack) || e}`));

const keyFile = () => path.join(app.getPath('userData'), 'tmdb.key');

function readKey() {
  try {
    const raw = fs.readFileSync(keyFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
  } catch (e) {
    return null;
  }
}

function writeKey(key) {
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8');
  fs.writeFileSync(keyFile(), data, { mode: 0o600 });
}

const makeTmdb = (key) => createTmdb({ key, fetchImpl: (url, opts) => net.fetch(url, opts) });

// Методы, которые может вызывать интерфейс. Остальное в процесс не проникает.
const SERVICE_METHODS = new Set(['getState', 'loadSeed', 'runImport', 'stopImport', 'progress', 'reviewList', 'resolveItem', 'skipItem', 'searchForReview', 'setFilmStatus', 'rate', 'toggleRewatch', 'finishReview', 'setTitle', 'toggleFav', 'ban', 'addNear', 'removeNear', 'moveNear', 'filmography', 'markFilm', 'finishMarkup', 'chooseNext', 'searchAdd', 'addFilm', 'addDirector']);

const local = {
  async hasKey() { return !!service.tmdb; },
  async setKey(key) {
    const clean = String(key || '').trim();
    const t = makeTmdb(clean);
    await t.ping();
    writeKey(clean);
    service.tmdb = t;
    return true;
  },
  async pickSeed() {
    const r = await dialog.showOpenDialog(win, { title: 'Файл начальных данных', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled) return false;
    service.loadSeed(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')));
    return true;
  },
  async openExternal(url) {
    if (/^https:\/\/(www\.)?kinopoisk\.ru\//.test(url) || /^https:\/\/(www\.)?themoviedb\.org\//.test(url)) await shell.openExternal(url);
  },
  async version() { return app.getVersion(); },
  async logPath() { return path.join(app.getPath('userData'), 'movie-night.log'); },
  async installUpdate() { autoUpdater.quitAndInstall(); },
};

function setupUpdates() {
  if (!app.isPackaged) return;
  const send = (u) => win && win.webContents.send('update', u);
  autoUpdater.on('update-available', (i) => send({ state: 'downloading', version: i.version }));
  autoUpdater.on('update-downloaded', (i) => send({ state: 'ready', version: i.version }));
  autoUpdater.on('error', () => {});
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

if (process.env.MN_USERDATA) app.setPath('userData', process.env.MN_USERDATA);

app.whenReady().then(() => {
  const dir = path.join(app.getPath('userData'), 'data');
  service = new Service({ dir, onProgress: (p) => win && win.webContents.send('progress', p) });
  const key = readKey();
  if (key) service.tmdb = makeTmdb(key);

  ipcMain.handle('api', async (_e, method, args) => {
    if (local[method]) return local[method](...args);
    if (SERVICE_METHODS.has(method)) return service[method](...args);
    throw new Error(`Неизвестный метод: ${method}`);
  });

  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 640, backgroundColor: '#0f1114',
    icon: path.join(__dirname, '..', 'build', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.webContents.on('preload-error', (_e, p, err) => logLine(`preload ${p}: ${err.stack || err}`));
  win.webContents.on('console-message', (_e, level, message, line, source) => { if (level >= 2) logLine(`renderer ${source}:${line} ${message}`); });
  win.webContents.on('render-process-gone', (_e, d) => logLine(`renderer gone: ${d.reason}`));
  win.webContents.on('before-input-event', (_e, input) => { if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools(); });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    setupUpdates();
    if (process.env.MN_SMOKE) {
      setTimeout(async () => {
        const text = await win.webContents.executeJavaScript('document.getElementById("app").innerText + " | api=" + typeof window.api').catch((e) => `ERR ${e}`);
        let log = '';
        try { log = fs.readFileSync(path.join(app.getPath('userData'), 'movie-night.log'), 'utf8'); } catch (e) { /* журнала нет */ }
        fs.writeFileSync(process.env.MN_SMOKE, `TEXT: ${text}\nLOG: ${log}\n`);
        app.quit();
      }, 5000);
    }
  });
});

app.on('window-all-closed', () => app.quit());
