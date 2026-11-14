'use strict';

/**
 * GaraBlox — лаунчер-оболочка поверх официального клиента Roblox.
 *
 * Что делает:
 *  - своё главное меню, избранные игры, темы оформления;
 *  - запускает игру через официальный протокол roblox:// (или через Fishstrap / Bloxstrap,
 *    если они выбраны как способ запуска);
 *  - умеет скачать и установить официальный Roblox Player.
 *
 * Чего НЕ делает (сознательно): не хранит пароли и cookies, не подменяет авторизацию,
 * не патчит и не подменяет клиент Roblox, не обходит античит и баны.
 */

const { app, BrowserWindow, ipcMain, shell, dialog, net, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const isDev = process.argv.includes('--dev');
const isShot = process.argv.includes('--shot');
const shotView = (process.argv.find((arg) => arg.startsWith('--view=')) || '').split('=')[1] || null;
const shotScroll = Number((process.argv.find((arg) => arg.startsWith('--scroll=')) || '').split('=')[1]) || 0;

/** Идентификатор «сессии» для публичных API каталога Roblox. */
const SESSION_ID = crypto.randomUUID();

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

const DEFAULT_STATE = {
  version: 1,
  theme: 'midnight',
  accent: 'violet',
  background: 'aurora',
  reduceMotion: false,
  launchMode: 'auto',
  customClientPath: '',
  games: [
    { placeId: 2753915549, name: 'Blox Fruits', addedAt: 1 },
    { placeId: 920587237, name: 'Adopt Me!', addedAt: 2 },
    { placeId: 1962086868, name: 'Tower of Hell', addedAt: 3 },
    { placeId: 606849621, name: 'Jailbreak', addedAt: 4 }
  ],
  featuredPlaceId: 2753915549,
  accounts: [
    { id: 'acc-main', name: 'Основной', note: 'Главный аккаунт', color: '#8b5cf6' }
  ],
  activeAccountId: 'acc-main',
  friends: []
};

let state = null;
let win = null;

/* ------------------------------------------------------------------ */
/*  Состояние                                                          */
/* ------------------------------------------------------------------ */

function statePath() {
  return path.join(app.getPath('userData'), 'garablox-state.json');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(patch)) return patch === undefined ? out : patch;
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    state = deepMerge(structuredClone(DEFAULT_STATE), raw);
  } catch {
    state = structuredClone(DEFAULT_STATE);
  }
  if (!Array.isArray(state.games)) state.games = structuredClone(DEFAULT_STATE.games);
  if (!Array.isArray(state.friends)) state.friends = [];
  if (!Array.isArray(state.accounts) || state.accounts.length === 0) {
    state.accounts = structuredClone(DEFAULT_STATE.accounts);
  }
  if (!state.accounts.some((a) => a.id === state.activeAccountId)) {
    state.activeAccountId = state.accounts[0].id;
  }
}

let saveTimer = null;
function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fsp.writeFile(statePath(), JSON.stringify(state, null, 2)).catch((err) => {
      console.error('[GaraBlox] не удалось сохранить состояние:', err.message);
    });
  }, 120);
}

/* ------------------------------------------------------------------ */
/*  Поиск установленных клиентов                                       */
/* ------------------------------------------------------------------ */

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* игнорируем */
    }
  }
  return null;
}

function detectRoblox() {
  const root = path.join(LOCAL, 'Roblox', 'Versions');
  let best = null;
  try {
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      const player = path.join(dir, 'RobloxPlayerBeta.exe');
      if (!fs.existsSync(player)) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(player).mtimeMs;
      } catch {
        /* игнорируем */
      }
      if (!best || mtime > best.mtime) {
        best = {
          dir,
          path: player,
          version: name.replace(/^version-/, ''),
          mtime
        };
      }
    }
  } catch {
    /* каталога нет */
  }
  return best ? { installed: true, ...best } : { installed: false, path: null, version: null };
}

function detectBootstrapper(kind) {
  const name = kind === 'fishstrap' ? 'Fishstrap.exe' : 'Bloxstrap.exe';
  const folder = kind === 'fishstrap' ? 'Fishstrap' : 'Bloxstrap';
  const exe = firstExisting([
    path.join(LOCAL, folder, name),
    path.join(PF, folder, name),
    path.join(PF86, folder, name)
  ]);
  return { installed: Boolean(exe), path: exe };
}

function detectClients() {
  return {
    roblox: detectRoblox(),
    fishstrap: detectBootstrapper('fishstrap'),
    bloxstrap: detectBootstrapper('bloxstrap'),
    protocol: getProtocolHandler()
  };
}

/* ------------------------------------------------------------------ */
/*  Обработчик протокола roblox://                                     */
/* ------------------------------------------------------------------ */

function regQueryValue(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/ve'], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const match = stdout.match(/REG_SZ\s+(.+?)\s*$/m);
      resolve(match ? match[1].trim() : null);
    });
  });
}

let protocolCache = { at: 0, value: null };

function exeFromCommand(command) {
  if (!command) return null;
  const quoted = command.match(/^"([^"]+\.exe)"/i);
  if (quoted) return quoted[1];
  const plain = command.match(/^(.+?\.exe)/i);
  return plain ? plain[1] : null;
}

function getProtocolHandler() {
  // Кэш на 5 секунд: функция вызывается при каждом запросе состояния.
  if (protocolCache.value && Date.now() - protocolCache.at < 5000) return protocolCache.value;

  const value = { raw: null, exe: null, kind: 'none' };
  protocolCache = { at: Date.now(), value };
  return value;
}

async function refreshProtocolHandler() {
  const keys = [
    'HKCU\\Software\\Classes\\roblox\\shell\\open\\command',
    'HKLM\\Software\\Classes\\roblox\\shell\\open\\command',
    'HKCU\\Software\\Classes\\roblox-player\\shell\\open\\command'
  ];
  let raw = null;
  for (const key of keys) {
    raw = await regQueryValue(key);
    if (raw) break;
  }
  const exe = exeFromCommand(raw);
  let kind = 'none';
  if (exe) {
    const lower = exe.toLowerCase();
    if (lower.includes('fishstrap')) kind = 'fishstrap';
    else if (lower.includes('bloxstrap')) kind = 'bloxstrap';
    else if (lower.includes('roblox')) kind = 'roblox';
    else kind = 'other';
  }
  protocolCache = { at: Date.now(), value: { raw, exe, kind } };
  return protocolCache.value;
}

/* ------------------------------------------------------------------ */
/*  Roblox API (названия, иконки, арты игр)                             */
/* ------------------------------------------------------------------ */

async function robloxJson(url, options = {}) {
  const { method = 'GET', body, timeout = 12000 } = options;
  const res = await net.fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function firstThumbnail(url) {
  try {
    const json = await robloxJson(url, { timeout: 9000 });
    const entry = json?.data?.[0];
    const image = entry?.imageUrl;
    if (typeof image === 'string' && image.startsWith('https://')) return image;
    return null;
  } catch {
    return null;
  }
}

/** Иконки игр пачкой: один запрос на список universeId. */
async function fetchGameIcons(universeIds) {
  const ids = [...new Set(universeIds.map(Number).filter(Boolean))].slice(0, 100);
  if (!ids.length) return {};

  try {
    const json = await robloxJson(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${ids.join(',')}` +
        '&returnPolicy=PlaceHolder&size=256x256&format=Png&isCircular=false',
      { timeout: 10000 }
    );
    const map = {};
    for (const item of json?.data || []) {
      if (item?.targetId && item?.imageUrl) map[item.targetId] = item.imageUrl;
    }
    return map;
  } catch {
    return {};
  }
}

function dedupeGames(games) {
  const seen = new Set();
  return games.filter((game) => {
    if (!game?.placeId || seen.has(game.placeId)) return false;
    seen.add(game.placeId);
    return true;
  });
}

/** Поиск по каталогу Roblox (публичный omni-search). */
async function searchGames(query, pageToken = '') {
  const token = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
  const json = await robloxJson(
    `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(query)}` +
      `&sessionId=${SESSION_ID}&pageType=all${token}`,
    { timeout: 15000 }
  );

  const raw = [];
  for (const group of json?.searchResults || []) {
    for (const item of group?.contents || []) {
      if (!item?.rootPlaceId) continue;
      if (item.contentType && item.contentType !== 'Game') continue;
      raw.push({
        placeId: item.rootPlaceId,
        universeId: item.universeId,
        name: item.name || `Игра ${item.rootPlaceId}`,
        creator: item.creatorName || '',
        playing: item.playerCount ?? null,
        upvotes: item.totalUpVotes ?? null,
        downvotes: item.totalDownVotes ?? null,
        description: item.description || '',
        maturity: item.ageRecommendationDisplayName || '',
        source: 'search'
      });
    }
  }

  const games = dedupeGames(raw);
  const icons = await fetchGameIcons(games.map((game) => game.universeId));
  for (const game of games) game.iconUrl = icons[game.universeId] || null;

  return { games, nextPageToken: json?.nextPageToken || null };
}

/** Рекомендации: официальные подборки каталога (тренды, новинки, «сейчас играют»). */
async function getRecommendations(sortId = 'top-trending') {
  const json = await robloxJson(
    `https://apis.roblox.com/explore-api/v1/get-sort-content?sortId=${encodeURIComponent(sortId)}` +
      `&sessionId=${SESSION_ID}&device=computer&country=all`,
    { timeout: 15000 }
  );

  const games = dedupeGames(
    (json?.games || [])
      .filter((game) => game?.rootPlaceId)
      .map((game) => ({
        placeId: game.rootPlaceId,
        universeId: game.universeId,
        name: game.name || `Игра ${game.rootPlaceId}`,
        creator: '',
        genre: game.genreL1 || '',
        playing: game.playerCount ?? null,
        upvotes: game.totalUpVotes ?? null,
        downvotes: game.totalDownVotes ?? null,
        source: 'recommendation'
      }))
  );

  const icons = await fetchGameIcons(games.map((game) => game.universeId));
  for (const game of games) game.iconUrl = icons[game.universeId] || null;

  return { sortId, sortName: json?.sortDisplayName || '', games: games.slice(0, 24) };
}

async function getSorts() {
  const json = await robloxJson(`https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=${SESSION_ID}`, {
    timeout: 12000
  });
  return (json?.sorts || [])
    .filter((sort) => sort?.contentType === 'Games' && sort.sortId && sort.sortId !== 'filters_v5')
    .map((sort) => ({ id: sort.sortId, name: sort.sortDisplayName || sort.sortId }));
}

/* ------------------------------------------------------------------ */
/*  Друзья (локальная книжка контактов, без авторизации)               */
/* ------------------------------------------------------------------ */

async function userHeadshot(userId) {
  return firstThumbnail(
    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}` +
      '&size=150x150&format=Png&isCircular=true&returnPolicy=PlaceHolder'
  );
}

async function resolveUser(username) {
  const cleaned = String(username || '').trim();
  if (!cleaned) throw new Error('Введи ник');

  const json = await robloxJson('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    body: { usernames: [cleaned], excludeBannedUsers: true },
    timeout: 10000
  });

  const user = json?.data?.[0];
  if (!user) throw new Error('Пользователь не найден');

  return {
    id: user.id,
    name: user.name,
    displayName: user.displayName || user.name,
    avatarUrl: await userHeadshot(user.id),
    addedAt: Date.now()
  };
}

async function refreshFriendAvatars() {
  if (!state.friends.length) return state.friends;
  const ids = state.friends.map((friend) => friend.id).slice(0, 50);
  try {
    const json = await robloxJson(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids.join(',')}` +
        '&size=150x150&format=Png&isCircular=true&returnPolicy=PlaceHolder',
      { timeout: 12000 }
    );
    const map = {};
    for (const item of json?.data || []) if (item?.imageUrl) map[item.targetId] = item.imageUrl;
    for (const friend of state.friends) if (map[friend.id]) friend.avatarUrl = map[friend.id];
    saveStateSoon();
  } catch {
    /* останутся старые ссылки или инициалы */
  }
  return state.friends;
}

function parsePlaceId(input) {
  if (input == null) return null;
  const text = String(input).trim();
  if (/^\d{3,20}$/.test(text)) return Number(text);
  const match = text.match(/games\/(\d{3,20})/i) || text.match(/placeId=(\d{3,20})/i);
  return match ? Number(match[1]) : null;
}

async function lookupGame(input) {
  const placeId = parsePlaceId(input);
  if (!placeId) throw new Error('Не понял ссылку. Нужен ID игры или ссылка вида roblox.com/games/123456');

  const uni = await robloxJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
  const universeId = uni?.universeId;
  if (!universeId) throw new Error('Игра не найдена по этому ID');

  const details = await robloxJson(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
  const data = details?.data?.[0];
  if (!data) throw new Error('Roblox не вернул данные об игре');

  const iconUrl = await firstThumbnail(
    `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}` +
      '&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false'
  );

  return {
    placeId,
    universeId,
    name: data.name || `Игра ${placeId}`,
    creator: data.creator?.name || '',
    creatorVerified: Boolean(data.creator?.hasVerifiedBadge),
    playing: data.playing ?? null,
    visits: data.visits ?? null,
    favoritedCount: data.favoritedCount ?? null,
    updated: data.updated || null,
    iconUrl,
    bannerUrl: null,
    fetchedAt: Date.now()
  };
}

/* ------------------------------------------------------------------ */
/*  Установка официального Roblox Player                               */
/* ------------------------------------------------------------------ */

function runProcess(file, args, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* игнорируем */
      }
      reject(new Error('Установщик не ответил вовремя'));
    }, timeout);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function sendProgress(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('install:progress', payload);
}

async function waitForPlayer(timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const detected = detectRoblox();
    if (detected.installed) return detected;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

async function installRoblox() {
  const installer = path.join(os.tmpdir(), `GaraBlox-RobloxPlayerInstaller-${Date.now()}.exe`);
  logLine('install: start');

  sendProgress({ phase: 'resolve', message: 'Получаю официальный установщик…' });
  const res = await net.fetch('https://www.roblox.com/download/client?os=win', { redirect: 'follow' });
  if (!res.ok) throw new Error(`Не удалось скачать установщик (HTTP ${res.status})`);

  const total = Number(res.headers.get('content-length') || 0);
  const sizeHint = total || Number(res.headers.get('content-range')?.split('/')?.[1] || 0);

  let received = 0;
  let lastEmit = 0;
  const out = fs.createWriteStream(installer);
  const body = res.body ? Readable.fromWeb(res.body) : Readable.from(Buffer.from(await res.arrayBuffer()));

  body.on('data', (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastEmit > 120) {
      lastEmit = now;
      sendProgress({
        phase: 'download',
        received,
        total: sizeHint,
        percent: sizeHint ? Math.min(100, (received / sizeHint) * 100) : null
      });
    }
  });

  try {
    await pipeline(body, out);
  } catch (err) {
    await fsp.unlink(installer).catch(() => {});
    throw new Error(`Загрузка прервалась: ${err.message}`);
  }

  sendProgress({ phase: 'install', message: 'Запускаю установщик Roblox…' });
  try {
    await runProcess(installer, ['/silent'], 300000);
  } finally {
    fsp.unlink(installer).catch(() => {});
  }

  sendProgress({ phase: 'wait', message: 'Жду, пока Roblox установится…' });
  const detected = await waitForPlayer();
  if (!detected) throw new Error('Установка завершилась, но Roblox Player не найден');

  logLine(`install: done ${detected.path}`);
  sendProgress({ phase: 'done', message: 'Готово — Roblox установлен' });
  return detected;
}

/* ------------------------------------------------------------------ */
/*  Запуск игры                                                        */
/* ------------------------------------------------------------------ */

function logFile() {
  return path.join(app.getPath('userData'), 'garablox.log');
}

function logLine(message) {
  try {
    fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* лог не критичен */
  }
}

function bootstrapperPathFor(mode) {
  if (mode === 'fishstrap') return detectBootstrapper('fishstrap').path;
  if (mode === 'bloxstrap') return detectBootstrapper('bloxstrap').path;
  if (mode === 'custom') return state.customClientPath || null;
  return null;
}

function spawnDetached(exe, args) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', (err) => logLine(`spawn failed ${exe}: ${err.message}`));
  child.unref();
  return child;
}

async function launchPlace(placeId) {
  const id = parsePlaceId(placeId);
  if (!id) throw new Error('Некорректный ID игры');

  const uri = `roblox://experiences/start?placeId=${id}`;
  const mode = state.launchMode;
  const detected = detectClients();
  const protocolKind = detected.protocol?.kind || 'none';
  logLine(`launch: placeId=${id} mode=${mode} protocol=${protocolKind} roblox=${detected.roblox.installed}`);

  // «Авто» — отдаём ссылку системе, её обрабатывает зарегистрированный клиент.
  if (mode === 'auto') {
    await openUri(uri);
    return { ok: true, via: `обработчик roblox:// (${protocolTitleOf(protocolKind)})`, uri };
  }

  if (mode === 'roblox') {
    if (!detected.roblox.installed) throw new Error('Roblox не установлен — сначала установи клиент');
    await openUri(uri);
    return { ok: true, via: 'обработчик roblox://', uri };
  }

  if (mode === 'fishstrap' || mode === 'bloxstrap') {
    // Если этот бутстраппер уже зарегистрирован как обработчик — просто открываем ссылку.
    if (protocolKind === mode) {
      await openUri(uri);
      return { ok: true, via: `обработчик roblox:// (${protocolTitleOf(protocolKind)})`, uri };
    }
    const exe = bootstrapperPathFor(mode);
    if (!exe) throw new Error(`${mode === 'fishstrap' ? 'Fishstrap' : 'Bloxstrap'} не найден — выбери его в настройках`);
    spawnDetached(exe, ['-player', uri]);
    logLine(`launch: spawned ${exe} -player ${uri}`);
    return { ok: true, via: path.basename(exe), uri };
  }

  if (mode === 'custom') {
    const exe = state.customClientPath;
    if (!exe) throw new Error('Свой клиент не выбран — укажи .exe в настройках');
    spawnDetached(exe, ['-player', uri]);
    logLine(`launch: spawned ${exe} -player ${uri}`);
    return { ok: true, via: path.basename(exe), uri };
  }

  await openUri(uri);
  return { ok: true, via: 'обработчик roblox://', uri };
}

async function openUri(uri) {
  try {
    await shell.openExternal(uri);
    logLine(`launch: openExternal ok ${uri}`);
  } catch (err) {
    logLine(`launch: openExternal failed ${uri} :: ${err.message}`);
    throw new Error(`Windows не смог открыть ссылку roblox:// (${err.message})`);
  }
}

function protocolTitleOf(kind) {
  return {
    roblox: 'официальный Roblox',
    fishstrap: 'Fishstrap',
    bloxstrap: 'Bloxstrap',
    other: 'другое приложение',
    none: 'не зарегистрирован'
  }[kind] || 'неизвестно';
}

/* ------------------------------------------------------------------ */
/*  IPC                                                                */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('state:get', async () => {
    await refreshProtocolHandler();
    return { state, clients: detectClients() };
  });

  ipcMain.handle('state:save', (_event, patch) => {
    state = deepMerge(state, patch || {});
    saveStateSoon();
    return state;
  });

  ipcMain.handle('state:reset', () => {
    state = structuredClone(DEFAULT_STATE);
    saveStateSoon();
    return state;
  });

  ipcMain.handle('game:lookup', async (_event, input) => lookupGame(input));

  ipcMain.handle('game:add', async (_event, input) => {
    const info = await lookupGame(input);
    const existing = state.games.find((g) => g.placeId === info.placeId);
    if (existing) {
      Object.assign(existing, info);
      saveStateSoon();
      return { game: existing, existed: true };
    }
    const game = { ...info, addedAt: Date.now() };
    state.games.unshift(game);
    if (!state.featuredPlaceId) state.featuredPlaceId = game.placeId;
    saveStateSoon();
    return { game, existed: false };
  });

  ipcMain.handle('game:refresh', async (_event, placeId) => {
    const game = state.games.find((g) => g.placeId === Number(placeId));
    if (!game) throw new Error('Игры нет в избранном');
    const info = await lookupGame(game.placeId);
    Object.assign(game, info);
    saveStateSoon();
    return game;
  });

  ipcMain.handle('game:remove', (_event, placeId) => {
    const id = Number(placeId);
    state.games = state.games.filter((g) => g.placeId !== id);
    if (state.featuredPlaceId === id) state.featuredPlaceId = state.games[0]?.placeId ?? null;
    saveStateSoon();
    return state;
  });

  ipcMain.handle('game:feature', (_event, placeId) => {
    state.featuredPlaceId = Number(placeId);
    saveStateSoon();
    return state.featuredPlaceId;
  });

  ipcMain.handle('game:launch', async (_event, placeId) => launchPlace(placeId));

  ipcMain.handle('game:openPage', async (_event, placeId) => {
    const id = parsePlaceId(placeId);
    if (!id) throw new Error('Некорректный ID игры');
    await shell.openExternal(`https://www.roblox.com/games/${id}`);
    return true;
  });

  ipcMain.handle('clients:detect', async () => {
    await refreshProtocolHandler();
    return detectClients();
  });

  ipcMain.handle('client:pick', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Выбери клиент для запуска',
      properties: ['openFile'],
      filters: [{ name: 'Приложения', extensions: ['exe'] }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    state.customClientPath = result.filePaths[0];
    saveStateSoon();
    return state.customClientPath;
  });

  ipcMain.handle('roblox:install', async () => {
    const detected = await installRoblox();
    return { clients: detectClients(), detected };
  });

  ipcMain.handle('app:openExternal', async (_event, url) => {
    const ok =
      typeof url === 'string' &&
      (/^https:\/\/([a-z0-9-]+\.)?roblox\.com(\/|$)/i.test(url) ||
        /^https:\/\/([a-z0-9-]+\.)?roblox\.com\//i.test(url) ||
        /^roblox:\/\//i.test(url));
    if (!ok) throw new Error('Ссылка не разрешена');
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('app:openRobloxApp', async () => {
    const detected = detectRoblox();
    if (!detected.installed) {
      throw new Error('Roblox не установлен — сначала установи клиент');
    }
    try {
      await shell.openExternal('roblox://');
      return { ok: true, via: 'protocol' };
    } catch {
      const child = spawn(detected.path, [], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, via: 'player' };
    }
  });

  ipcMain.handle('app:statePath', async () => {
    const p = statePath();
    await shell.openPath(path.dirname(p));
    return p;
  });

  ipcMain.handle('catalog:search', async (_event, query, pageToken) => {
    const text = String(query || '').trim();
    if (!text) throw new Error('Введи название игры');
    return searchGames(text, pageToken);
  });

  ipcMain.handle('catalog:recommendations', async (_event, sortId) => getRecommendations(sortId));

  ipcMain.handle('catalog:sorts', async () => getSorts());

  ipcMain.handle('friends:add', async (_event, username) => {
    const friend = await resolveUser(username);
    if (state.friends.some((item) => item.id === friend.id)) {
      throw new Error('Такой друг уже в списке');
    }
    state.friends.unshift(friend);
    saveStateSoon();
    logLine(`friends: added ${friend.name} (${friend.id})`);
    return { friends: state.friends, friend };
  });

  ipcMain.handle('friends:remove', (_event, id) => {
    state.friends = state.friends.filter((friend) => String(friend.id) !== String(id));
    saveStateSoon();
    return state.friends;
  });

  ipcMain.handle('friends:refresh', async () => refreshFriendAvatars());

  ipcMain.handle('app:openLog', async () => {
    const file = logFile();
    try {
      await fsp.access(file);
    } catch {
      await fsp.writeFile(file, `GaraBlox log\n`);
    }
    await shell.openPath(file);
    return file;
  });

  ipcMain.handle('win:minimize', () => win?.minimize());
  ipcMain.handle('win:toggleMaximize', () => {
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('win:close', () => win?.close());
}

/* ------------------------------------------------------------------ */
/*  Окно                                                               */
/* ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1000,
    minHeight: 680,
    frame: false,
    show: false,
    backgroundColor: '#0b0b12',
    title: 'GaraBlox',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'), {
    query: shotView ? { view: shotView } : {}
  });
  win.once('ready-to-show', () => win.show());

  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/([a-z0-9-]+\.)?roblox\.com/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  if (isShot) {
    win.webContents.once('did-finish-load', async () => {
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      try {
        // Для скриншотов выключаем анимации, чтобы не поймать кадр «на полпути».
        await win.webContents.executeJavaScript("document.documentElement.dataset.motion = 'off'; true").catch(() => {});

        await pause(3500);

        if (shotView === 'search') {
          await win.webContents
            .executeJavaScript(`
              (() => {
                const form = document.querySelector('#search-form');
                const input = document.querySelector('#search-input');
                if (!form || !input) return false;
                input.value = 'blox fruits';
                form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
                return true;
              })()
            `)
            .catch(() => {});
          await pause(4200);
        }

        // Прокрутка — в самом конце, потому что перерисовка сбрасывает scrollTop.
        if (shotScroll > 0) {
          await win.webContents
            .executeJavaScript(`
              (() => {
                const el = document.querySelector('#content') || document.scrollingElement;
                el.scrollTop = ${shotScroll};
                return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
              })()
            `)
            .catch(() => {});
          await pause(600);
        }

        const image = await win.webContents.capturePage();
        await fsp.writeFile(path.join(__dirname, 'shot.png'), image.toPNG());
        console.log('[GaraBlox] скриншот сохранён: shot.png');
      } catch (err) {
        console.error('[GaraBlox] скриншот не удался:', err.message);
      } finally {
        app.quit();
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Старт                                                              */
/* ------------------------------------------------------------------ */

if (!isShot && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    app.setAppUserModelId('com.garaaimi.garablimox');
    loadState();
    await refreshProtocolHandler();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
