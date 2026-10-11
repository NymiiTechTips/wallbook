const { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, Tray } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execFile } = require('child_process');
const { fileURLToPath, pathToFileURL } = require('url');
const { buildDesktopWallpaperScript } = require('./desktop-wallpaper');

let mainWindow;
let tray;
let trayMenu;
let yabaiRuleReady = false;
let yabaiRuleSetup;
const wallpapersRepo = 'NymiiTechTips/wallpapers';
const imageExtensions = new Set(['.avif', '.bmp', '.gif', '.heic', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);

function getYabaiPath() {
  const pathEntries = (process.env.PATH || '').split(path.delimiter);
  return ['/opt/homebrew/bin/yabai', '/usr/local/bin/yabai', ...pathEntries.map((entry) => path.join(entry, 'yabai'))]
    .find((candidate) => fs.existsSync(candidate)) || 'yabai';
}

function ensureYabaiFloatRule() {
  if (process.platform !== 'darwin' || yabaiRuleReady) return Promise.resolve(yabaiRuleReady);
  if (yabaiRuleSetup) return yabaiRuleSetup;

  yabaiRuleSetup = new Promise((resolve) => {
    execFile(getYabaiPath(), ['-m', 'rule', '--add', 'title=^Wallbook$', 'manage=off'], (error) => {
      yabaiRuleReady = !error;
      yabaiRuleSetup = null;
      if (error) console.warn('Impossible de créer la règle flottante yabai:', error.message);
      resolve(yabaiRuleReady);
    });
  });

  return yabaiRuleSetup;
}

function floatWallbookInYabai() {
  if (process.platform !== 'darwin') return;

  const yabaiPath = getYabaiPath();
  execFile(yabaiPath, ['-m', 'query', '--windows'], (error, stdout) => {
    if (error) return;

    try {
      const wallbookWindow = JSON.parse(stdout).find((window) => window.title === 'Wallbook');
      if (wallbookWindow && !wallbookWindow['is-floating']) {
        execFile(yabaiPath, ['-m', 'window', String(wallbookWindow.id), '--toggle', 'float'], (floatError) => {
          if (floatError) console.warn('Impossible de passer Wallbook en flottant dans yabai:', floatError.message);
        });
      }
    } catch (queryError) {
      console.warn('Réponse yabai illisible:', queryError.message);
    }
  });
}

function requestBuffer(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 5) {
          reject(new Error('Trop de redirections lors du téléchargement.'));
          return;
        }

        const nextUrl = new URL(response.headers.location, url).toString();
        requestBuffer(nextUrl, headers, redirects + 1).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GitHub a répondu avec le statut HTTP ${response.statusCode}.`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

function readWallpaperCache(cacheDir) {
  try {
    const manifestPath = path.join(cacheDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Array.isArray(manifest.wallpapers) ? manifest.wallpapers : [];
  } catch {
    return [];
  }
}

function getCachedWallpapers(cacheDir) {
  return readWallpaperCache(cacheDir)
    .filter((wallpaper) => fs.existsSync(path.join(cacheDir, wallpaper.fileName)))
    .map((wallpaper) => ({
      name: wallpaper.name,
      url: pathToFileURL(path.join(cacheDir, wallpaper.fileName)).toString(),
    }));
}

async function syncWallpapers() {
  const cacheDir = path.join(app.getPath('userData'), 'wallpapers');
  fs.mkdirSync(cacheDir, { recursive: true });
  const previousWallpapers = readWallpaperCache(cacheDir);
  const previousByPath = new Map(previousWallpapers.map((wallpaper) => [wallpaper.repoPath, wallpaper]));

  const treeBuffer = await requestBuffer(
    `https://api.github.com/repos/${wallpapersRepo}/git/trees/main?recursive=1`,
    { Accept: 'application/vnd.github+json', 'User-Agent': 'Wallbook' },
  );
  const treeData = JSON.parse(treeBuffer.toString('utf8'));
  if (treeData.truncated) {
    throw new Error('Le catalogue GitHub est trop volumineux pour être synchronisé en une seule requête.');
  }

  const imageFiles = (treeData.tree || []).filter((item) =>
    item.type === 'blob' && imageExtensions.has(path.extname(item.path).toLowerCase()),
  );
  if (!imageFiles.length) {
    throw new Error('Aucune image trouvée dans le dépôt GitHub.');
  }

  const wallpapers = imageFiles.map((item) => {
    const extension = path.extname(item.path).toLowerCase();
    const fileName = `${item.sha}${extension}`;
    const previous = previousByPath.get(item.path);
    return {
      repoPath: item.path,
      sha: item.sha,
      fileName,
      name: path.basename(item.path, extension).replace(/[_-]+/g, ' '),
      needsDownload: previous?.sha !== item.sha || !fs.existsSync(path.join(cacheDir, fileName)),
    };
  });

  const pending = wallpapers.filter((wallpaper) => wallpaper.needsDownload);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < pending.length) {
      const wallpaper = pending[nextIndex++];
      const url = `https://raw.githubusercontent.com/${wallpapersRepo}/main/${wallpaper.repoPath
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;
      const contents = await requestBuffer(url, { 'User-Agent': 'Wallbook' });
      fs.writeFileSync(path.join(cacheDir, wallpaper.fileName), contents);
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));

  const manifestPath = path.join(cacheDir, 'manifest.json');
  const manifestTempPath = `${manifestPath}.tmp`;
  fs.writeFileSync(manifestTempPath, JSON.stringify({ wallpapers }, null, 2));
  fs.renameSync(manifestTempPath, manifestPath);

  const activeFiles = new Set(wallpapers.map((wallpaper) => wallpaper.fileName));
  for (const wallpaper of previousWallpapers) {
    if (!activeFiles.has(wallpaper.fileName)) {
      fs.rmSync(path.join(cacheDir, wallpaper.fileName), { force: true });
    }
  }

  return {
    wallpapers: getCachedWallpapers(cacheDir),
    downloaded: pending.length,
  };
}

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    await ensureYabaiFloatRule();
    mainWindow.show();
    mainWindow.focus();
    floatWallbookInYabai();
    return;
  }

  await ensureYabaiFloatRule();
  mainWindow = new BrowserWindow({
    type: 'panel',
    title: 'Wallbook',
    width: 1200,
    height: 800,
    minWidth: 980,
    minHeight: 560,
    frame: false,
    transparent: true,
    titleBarStyle: 'hiddenInset',
    resizable: true,
    show: false,
    backgroundColor: '#00000000',
    hasShadow: false,
    fullscreenable: false,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.platform === 'darwin') {
    mainWindow.setWindowButtonVisibility(false);
  }
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
    }
  });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
    floatWallbookInYabai();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('Wallbook');
  trayMenu = Menu.buildFromTemplate([
    { label: 'Ouvrir', click: createWindow },
    {
      label: 'Fetch les images GitHub',
      click: async () => {
        try {
          const result = await syncWallpapers();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('wallpapers-synced', result);
          }
          new Notification({
            title: 'Wallbook',
            body: result.downloaded
              ? `${result.downloaded} image(s) récupérée(s) ou mise(s) à jour.`
              : 'Les images sont déjà à jour.',
          }).show();
        } catch (error) {
          console.error('Échec de la synchronisation des wallpapers:', error);
          new Notification({ title: 'Wallbook', body: 'Impossible de récupérer les images GitHub.' }).show();
        }
      },
    },
    { label: 'Relancer', click: () => {
      app.relaunch();
      app.quit();
    } },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]);
  tray.on('click', createWindow);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu));
}

async function downloadWallpaper(url) {
  const tmpDir = path.join(os.tmpdir(), 'wallbook-wallpapers');
  fs.mkdirSync(tmpDir, { recursive: true });

  const fileName = `${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`;
  const filePath = path.join(tmpDir, fileName);

  await new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        https.get(response.headers.location, (redirectResponse) => {
          handleResponse(redirectResponse);
        }).on('error', reject);
        return;
      }

      handleResponse(response);

      function handleResponse(res) {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download wallpaper: HTTP ${res.statusCode}`));
          return;
        }

        const fileStream = fs.createWriteStream(filePath);
        res.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(resolve));
        fileStream.on('error', reject);
      }
    });

    request.on('error', reject);
  });

  return filePath;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

async function queryYabaiSpaces() {
  const yabaiPath = getYabaiPath();
  return JSON.parse(await runCommand(yabaiPath, ['-m', 'query', '--spaces']));
}

async function focusYabaiSpace(index) {
  const yabaiPath = getYabaiPath();
  await runCommand(yabaiPath, ['-m', 'space', '--focus', String(index)]);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const spaces = await queryYabaiSpaces();
    if (spaces.some((space) => space.index === index && space['has-focus'])) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Impossible d’activer le Space ${index}.`);
}

async function setCurrentDesktopWallpapers(filePath) {
  const desktopCountRaw = await runCommand('osascript', ['-e', 'tell application "System Events" to count desktops']);
  const desktopCount = Number.parseInt(desktopCountRaw, 10);

  if (!Number.isInteger(desktopCount) || desktopCount <= 0) {
    throw new Error('Aucun bureau macOS détecté pour appliquer le fond d’écran.');
  }

  const script = buildDesktopWallpaperScript(filePath, desktopCount);
  await runCommand('osascript', ['-e', script]);

  try {
    const finderScript = `tell application "Finder" to set desktop picture to POSIX file "${filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    await runCommand('osascript', ['-e', finderScript]);
  } catch (fallbackError) {
    console.warn('Fallback Finder pour le premier bureau impossible:', fallbackError.message);
  }
}

async function applyAllSpacesWallpaper(filePath) {
  if (process.platform !== 'darwin') {
    throw new Error('L’application des wallpapers macOS nécessite macOS.');
  }

  let spaces;
  try {
    spaces = await queryYabaiSpaces();
  } catch (error) {
    throw new Error(`Impossible de lister les Spaces avec yabai : ${error.message}`);
  }

  if (!spaces.length) {
    throw new Error('Aucun Space macOS n’a été trouvé.');
  }

  const desktops = await runCommand('osascript', ['-e', 'tell application "System Events" to count desktops']);
  const desktopCount = Number.parseInt(desktops, 10);
  if (spaces.length > desktopCount) {
    console.warn(
      'macOS expose des bureaux d’affichage, pas un wallpaper distinct pour chaque Space. ' +
      'Le fond d’écran sera appliqué au display actif; les Spaces cachés restent limités par l’API publique.',
    );
  }

  const originalSpace = spaces.find((space) => space['has-focus']);
  let updateError;

  try {
    for (const space of spaces) {
      await focusYabaiSpace(space.index);
      await setCurrentDesktopWallpapers(filePath);
    }
  } catch (error) {
    updateError = error;
  } finally {
    if (originalSpace) {
      try {
        await focusYabaiSpace(originalSpace.index);
      } catch (restoreError) {
        console.error('Impossible de restaurer le Space de départ:', restoreError);
      }
    }
  }

  if (updateError) {
    throw new Error(`Le wallpaper n’a pas pu être appliqué à tous les Spaces : ${updateError.message}`);
  }
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.hide();
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
      args: process.defaultApp ? [path.resolve(process.argv[1])] : [],
    });
  }
  createTray();

  app.on('activate', () => {
    createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('pick-wallpaper', async (_event, wallpaperUrl) => {
  if (!wallpaperUrl) {
    throw new Error('Aucun wallpaper sélectionné.');
  }

  try {
    let filePath;
    const wallpaperProtocol = new URL(wallpaperUrl).protocol;
    if (wallpaperProtocol === 'file:') {
      filePath = fileURLToPath(wallpaperUrl);
      const wallpaperCache = `${path.resolve(app.getPath('userData'), 'wallpapers')}${path.sep}`;
      if (!path.resolve(filePath).startsWith(wallpaperCache) || !fs.existsSync(filePath)) {
        throw new Error('Le wallpaper sélectionné ne se trouve pas dans le cache.');
      }
    } else if (wallpaperProtocol === 'https:') {
      filePath = await downloadWallpaper(wallpaperUrl);
    } else {
      throw new Error(`Protocole de wallpaper non pris en charge : ${wallpaperProtocol}`);
    }

    if (process.platform !== 'darwin') {
      throw new Error('Cette app est conçue pour macOS.');
    }

    await applyAllSpacesWallpaper(filePath);
    mainWindow?.close();
    return { success: true };
  } catch (error) {
    console.error('Erreur lors du choix du wallpaper:', error);
    throw error;
  }
});

ipcMain.handle('sync-wallpapers', async () => {
  const cacheDir = path.join(app.getPath('userData'), 'wallpapers');
  try {
    return await syncWallpapers();
  } catch (error) {
    const cachedWallpapers = getCachedWallpapers(cacheDir);
    if (cachedWallpapers.length) {
      console.warn('Synchronisation GitHub impossible, utilisation du cache local:', error);
      return { wallpapers: cachedWallpapers, downloaded: 0, offline: true };
    }

    throw error;
  }
});
