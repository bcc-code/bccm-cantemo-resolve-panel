'use strict';

// Portal for Resolve: Electron main process. Owns all network, filesystem and Resolve
// access; the sandboxed renderer talks to it only through the IPC calls in preload.js.

const { app, BrowserWindow, ipcMain, net, shell, safeStorage, session } = require('electron');
const path = require('path');
const { PortalClient } = require('./src/portal-client');
const { Settings } = require('./src/settings');
const paths = require('./src/path-mapper');
const bridge = require('./src/resolve-bridge');

const PLUGIN_ID = 'media.bcc.portal';
const NLE_BATCH = 50;
const MAX_COLLECTION_IMPORT = 1000;
// Cookies from the access proxy in front of Portal (IAP) live in this persistent session,
// and every Portal/Vidispine request goes through it.
const PARTITION = 'persist:portal';
const REQUEST_TIMEOUT_MS = 60000;
// The access proxy's cookie is a session cookie, which Electron drops when the plugin
// closes. Keep a copy this long; if the proxy rejects it sooner we simply sign in again.
const PROXY_COOKIE_DAYS = 7;
// Show the sign-in window only if the identity provider has not signed in silently by then.
const SIGN_IN_SHOW_DELAY_MS = 2500;

let win = null;
let settings = null;
let client = null;
const itemCache = new Map(); // id -> enriched item as sent to the renderer
const fileCache = new Map(); // id -> Portal's nle_data files { original, proxy }, re-resolved before import
const thumbCache = new Map();

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function makeClient(password = settings.getPassword()) {
  const d = settings.data;
  if (!d.baseUrl || !d.username || !password) return null;
  return new PortalClient({ baseUrl: d.baseUrl, username: d.username, password, descriptionField: d.descriptionField, fetch: portalFetch });
}

function requireClient() {
  if (!client) throw new Error('Not signed in to Portal');
  return client;
}

const PLATFORM = process.platform === 'win32' ? 'win' : 'mac';

function locate(file) {
  return file ? paths.resolveFile(file, settings.data.rewrites) : null;
}

// Search hits -> items with Portal's local paths for this OS, in one nle_data call per batch.
async function enrichPage(page) {
  const ids = page.results.map((r) => r.id);
  const files = {};
  let error = null;
  for (let i = 0; i < ids.length; i += NLE_BATCH) {
    try {
      Object.assign(files, (await requireClient().nleData(ids.slice(i, i + NLE_BATCH), PLATFORM)).files);
    } catch (err) {
      if (err.code === 'GATEWAY_AUTH') throw err;
      error = err.message;
    }
  }
  const items = page.results.map((hit) => {
    const f = files[hit.id];
    const item = {
      ...hit,
      portalUrl: client.itemPageUrl(hit.id),
      original: f ? locate(f.original) : null,
      proxy: f ? locate(f.proxy) : null,
      error: f ? null : error || 'Portal returned no file information for this item',
    };
    itemCache.set(item.id, item);
    if (f) fileCache.set(item.id, f);
    return item;
  });
  return { total: page.total, items };
}

async function importItems({ ids, linkProxy, proxyOnlyFallback }) {
  const d = settings.data;
  const existing = d.skipExisting ? await bridge.portalIdsInCurrentBin() : new Set();
  const summary = { imported: 0, proxiesLinked: 0, skippedExisting: 0, failed: [], warnings: [] };
  for (let i = 0; i < ids.length; i++) {
    const item = itemCache.get(ids[i]);
    send('import:progress', { index: i, total: ids.length, title: item ? item.title : ids[i] });
    if (!item) {
      summary.failed.push({ id: ids[i], title: ids[i], reason: 'Item details not loaded' });
      continue;
    }
    if (existing.has(item.id)) {
      summary.skippedExisting++;
      continue;
    }
    // Re-check now: volumes can be unmounted after the search ran.
    const files = fileCache.get(item.id) || {};
    const original = locate(files.original);
    const proxy = locate(files.proxy);
    const originalOk = original && original.status === 'found';
    const proxyOk = proxy && proxy.status === 'found';
    let mediaPath = null;
    let proxyPath = null;
    if (originalOk) {
      mediaPath = original.localPath;
      if (linkProxy && proxyOk) proxyPath = proxy.localPath;
    } else if (proxyOnlyFallback && proxyOk) {
      mediaPath = proxy.localPath;
    }
    if (!mediaPath) {
      summary.failed.push({ id: item.id, title: item.title, reason: describeStatus(original) });
      continue;
    }
    try {
      const r = await bridge.importClip({
        id: item.id,
        title: item.title,
        description: item.description,
        mediaPath,
        proxyPath,
        writeMetadata: d.writeMetadata,
      });
      summary.imported++;
      if (r.proxyLinked) summary.proxiesLinked++;
      else if (proxyPath) summary.warnings.push({ id: item.id, title: item.title, reason: 'Imported, but Resolve did not link the proxy' });
      existing.add(item.id);
    } catch (err) {
      summary.failed.push({ id: item.id, title: item.title, reason: err.message });
    }
  }
  send('import:progress', { index: ids.length, total: ids.length, done: true });
  return summary;
}

function describeStatus(r) {
  if (!r) return 'Portal returned no file information';
  switch (r.status) {
    case 'none':
    case 'unavailable':
      return r.detail || 'Portal reports the file as not accessible';
    case 'not_mounted':
      return `Volume not mounted: ${paths.mountRoot(r.localPath) || r.localPath}`;
    case 'missing':
      return `File not found at ${r.localPath}`;
    default:
      return 'File not available';
  }
}

// Every handler returns { ok: true, data } or { ok: false, error } so the renderer never
// sees Electron's wrapped exception text.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, arg) => {
    try {
      try {
        return { ok: true, data: await fn(arg) };
      } catch (err) {
        if (err.code !== 'GATEWAY_AUTH') throw err;
        await signInToGateway(err.origin);
        return { ok: true, data: await fn(arg) };
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function registerHandlers() {
  handle('app:state', async () => ({
    settings: settings.public(),
    signedIn: !!client,
    canEncrypt: settings.canEncrypt(),
    platform: process.platform,
    resolve: { available: bridge.available(), reason: bridge.unavailableReason() },
  }));

  handle('auth:login', async ({ baseUrl, username, password, remember }) => {
    const candidate = new PortalClient({ baseUrl, username, password, descriptionField: settings.data.descriptionField, fetch: portalFetch });
    await candidate.whoami();
    settings.setCredentials({ baseUrl: candidate.baseUrl, username, password, remember });
    client = candidate;
    return settings.public();
  });

  handle('auth:logout', async () => {
    settings.clearCredentials();
    await portalSession().clearStorageData();
    client = null;
    itemCache.clear();
    fileCache.clear();
    thumbCache.clear();
  });

  handle('settings:save', async (partial) => {
    const s = settings.update(partial);
    if ('baseUrl' in partial || 'descriptionField' in partial) client = makeClient();
    return s;
  });

  handle('portal:search', async ({ params, page }) => enrichPage(await requireClient().search(params, { page })));
  handle('portal:savedSearches', async () => requireClient().listSavedSearches());
  handle('portal:runSaved', async ({ id, page }) => enrichPage(await requireClient().runSavedSearch(id, { page })));
  handle('portal:collections', async () => requireClient().listCollections());
  handle('portal:collectionItems', async ({ id, page }) => enrichPage(await requireClient().collectionItems(id, { page })));

  handle('portal:collectionAll', async ({ id }) => {
    const hits = [];
    for (let page = 1; hits.length < MAX_COLLECTION_IMPORT; page++) {
      const r = await requireClient().collectionItems(id, { page, pageSize: 100 });
      hits.push(...r.results);
      if (!r.results.length || hits.length >= r.total) break;
    }
    return (await enrichPage({ total: hits.length, results: hits.slice(0, MAX_COLLECTION_IMPORT) })).items.filter((x) => !x.error);
  });

  handle('portal:thumbnail', async (id) => {
    if (thumbCache.has(id)) return thumbCache.get(id);
    const item = itemCache.get(id);
    if (!item || !item.thumbnail) return null;
    const data = await requireClient().fetchImage(item.thumbnail);
    thumbCache.set(id, data);
    return data;
  });

  handle('paths:test', async (rules) => paths.testRewrites(rules || settings.data.rewrites));

  handle('resolve:bin', async () => (bridge.available() ? bridge.currentBinPath() : null));
  handle('resolve:import', importItems);

  handle('shell:openPortal', async (id) => {
    await shell.openExternal(requireClient().itemPageUrl(id));
  });
  handle('shell:reveal', async (localPath) => {
    // Only reveal paths we resolved ourselves.
    const known = [...itemCache.values()].some((i) => [i.original, i.proxy].some((f) => f && f.localPath === localPath));
    if (!known) throw new Error('Unknown path');
    shell.showItemInFolder(localPath);
  });
}

function portalSession() {
  return session.fromPartition(PARTITION);
}

// fetch()-like request through the Portal session. Built on net.request rather than
// session.fetch because session.fetch hides redirects (empty `url`, `redirected: false`):
// same-origin redirects are followed, a redirect to another origin (the access proxy's
// sign-in page) stops and is reported through `url`/`redirected`.
function portalFetch(url, { method = 'GET', headers = {}, body } = {}) {
  const origin = new URL(url).origin;
  return new Promise((resolve, reject) => {
    const req = net.request({ method, url, session: portalSession(), useSessionCookies: true, redirect: 'manual' });
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    const respond = (res, finalUrl, chunks) => {
      const buf = Buffer.concat(chunks);
      const get = (k) => {
        const v = res ? res.headers[k.toLowerCase()] : undefined;
        return Array.isArray(v) ? v.join(', ') : v || null;
      };
      resolve({
        ok: !!res && res.statusCode >= 200 && res.statusCode < 300,
        status: res ? res.statusCode : 0,
        statusText: res ? res.statusMessage : '',
        url: finalUrl,
        redirected: finalUrl !== url,
        headers: { get },
        text: async () => buf.toString('utf8'),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
      });
    };
    let current = url;
    req.on('redirect', (_status, _method, redirectUrl) => {
      if (new URL(redirectUrl).origin === origin) {
        current = redirectUrl;
        req.followRedirect();
      } else {
        req.abort();
        respond(null, redirectUrl, []);
      }
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => respond(res, current, chunks));
      res.on('error', reject);
    });
    req.on('error', reject);
    // A 401 with a WWW-Authenticate challenge makes net.request wait for credentials
    // forever; credentials are already in the Authorization header, so cancel and let the
    // 401 response through.
    req.on('login', (_info, callback) => callback());
    const timer = setTimeout(() => {
      req.abort();
      reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000} s`));
    }, REQUEST_TIMEOUT_MS);
    req.on('close', () => clearTimeout(timer));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Opens the access proxy's sign-in page in a window sharing the Portal session. It closes
// as soon as navigation lands back on Portal's origin, i.e. the proxy has set its cookie.
// It stays hidden when the cookie is still valid or the identity provider signs in silently.
let gatewayPending = null;
function signInToGateway(origin) {
  if (gatewayPending) return gatewayPending;
  gatewayPending = new Promise((resolve, reject) => {
    let done = false;
    let showTimer = null;
    const w = new BrowserWindow({
      width: 520,
      height: 720,
      show: false,
      parent: win || undefined,
      title: 'Sign in to Portal access',
      backgroundColor: '#ffffff',
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    // Identity providers such as Google refuse sign-in from user agents that look embedded.
    const ua = w.webContents
      .getUserAgent()
      .replace(/\sElectron\/\S+/, '')
      .replace(new RegExp(`\\s${app.getName().replace(/[^\w-]/g, '.')}\\/\\S+`), '');
    w.webContents.setUserAgent(ua);
    const onUrl = (_e, url) => {
      let here;
      try {
        here = new URL(url).origin;
      } catch {
        return;
      }
      if (here === origin) {
        if (done) return;
        done = true;
        // did-navigate fires once Portal's host has answered, so the proxy's cookie is set.
        // Persist it, then close outside this event: destroying a window from inside its
        // own navigation callback crashes Electron.
        portalSession()
          .cookies.flushStore()
          .catch(() => {})
          .then(() => {
            resolve();
            setTimeout(() => {
              if (!w.isDestroyed()) w.close();
            }, 0);
          });
      } else if (!w.isVisible() && !showTimer) {
        // Usually Microsoft/Google sign in silently and redirect back within a second;
        // only bother the user when the page is still waiting for them.
        showTimer = setTimeout(() => {
          if (!done && !w.isDestroyed()) w.show();
        }, SIGN_IN_SHOW_DELAY_MS);
      }
    };
    // Only committed navigations count. A redirect back towards Portal (the identity
    // provider's callback) has not reached Portal yet, and the cookie is set in its response.
    w.webContents.on('did-navigate', onUrl);
    w.on('closed', () => {
      clearTimeout(showTimer);
      if (!done) reject(new Error('Sign-in to the access proxy was cancelled'));
    });
    w.loadURL(origin + '/').catch(() => {});
  }).finally(() => {
    gatewayPending = null;
  });
  return gatewayPending;
}

// Re-store session cookies for Portal's host with an expiry so the proxy sign-in survives
// closing the plugin. Only cookies of the configured Portal host are touched.
function persistProxyCookies() {
  const ses = portalSession();
  ses.cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (removed || !cookie.session || !settings.data.baseUrl) return;
    let host;
    try {
      host = new URL(settings.data.baseUrl).hostname;
    } catch {
      return;
    }
    const domain = (cookie.domain || '').replace(/^\./, '');
    if (!(host === domain || host.endsWith('.' + domain))) return;
    ses.cookies
      .set({
        url: `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path || '/'}`,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.hostOnly ? undefined : cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: Date.now() / 1000 + PROXY_COOKIE_DAYS * 86400,
      })
      .then(() => ses.cookies.flushStore())
      .catch(() => {});
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 480,
    minHeight: 560,
    useContentSize: true,
    backgroundColor: '#1f1f22',
    title: 'Portal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  settings = new Settings(app.getPath('userData'), safeStorage);
  client = makeClient();
  bridge.load(__dirname);
  try {
    await bridge.init(PLUGIN_ID);
  } catch {
    // reported to the UI through app:state
  }
  persistProxyCookies();
  registerHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  bridge.cleanUp();
  app.quit();
});
