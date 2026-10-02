'use strict';

// Portal for Resolve: renderer. Plain DOM, no framework. All data comes from window.portal
// (preload.js); every call resolves to { ok, data } or { ok: false, error }.

const api = window.portal;

// ---------- tiny DOM helpers ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM, allowed by the CSP (style attributes are not)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  grid: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  audio: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 7"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17h.01"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};

function icon(name, size = 16, stroke = 2) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', stroke);
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name]; // static, trusted markup
  return s;
}

// ---------- state ----------

const state = {
  view: 'login',
  app: null,
  layout: 'grid',
  search: { query: '', type: 'any', date: 'any', duration: 'any', onlyMounted: false, items: [], total: 0, page: 1, loading: false, error: null, ran: false },
  browse: { saved: [], collections: [], open: new Set(), filter: '', target: null, items: [], total: 0, page: 1, loading: false, error: null, loaded: false },
  selection: new Set(),
  detailId: null,
  bin: null,
  importing: null,
  dialog: null,
  toast: null,
  login: { error: null, busy: false },
  settingsUi: { tests: {}, saved: false, error: null },
};

const thumbs = new Map();

function currentList() {
  return state.view === 'browse' ? state.browse : state.search;
}

function findItem(id) {
  return state.search.items.find((i) => i.id === id) || state.browse.items.find((i) => i.id === id);
}

// ---------- formatting ----------

function fmtDuration(sec) {
  if (sec == null) return '';
  const s = Math.round(sec);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
}

function fmtDateTime(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? String(v) : `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`;
}

const STATUS_LABEL = { not_mounted: 'Not mounted', missing: 'Missing', unavailable: 'Unavailable', none: 'None' };

// Portal explains unavailable files in `detail`; archived ones get their own label.
function statusLabel(f) {
  if (!f) return 'None';
  if (f.status === 'unavailable' && /archiv/i.test(f.detail || '')) return 'Archived';
  return STATUS_LABEL[f.status] || f.status;
}

function originalOk(item) {
  return !!(item.original && item.original.status === 'found');
}

function proxyOk(item) {
  return !!(item.proxy && item.proxy.status === 'found');
}

function offlineLabel(item) {
  if (item.error) return 'Error';
  if (!item.original) return 'No original';
  return originalOk(item) ? null : statusLabel(item.original);
}

function problemReason(item) {
  if (item.error) return { why: 'Error', text: item.error };
  const o = item.original;
  if (!o) return { why: 'No original', text: 'Portal has no original shape for this item' };
  if (o.status === 'not_mounted') return { why: 'Not mounted', text: o.localPath, link: true };
  if (o.status === 'missing') return { why: 'Missing', text: `Not found: ${o.localPath}` };
  return { why: statusLabel(o), text: o.detail || o.portalPath || 'Portal reports the file as not accessible' };
}

function metaLine(item) {
  const fmt = item.resolution || (item.mediaType && item.mediaType !== 'unknown' ? item.mediaType : '');
  return [fmt, fmtDate(item.created)].filter(Boolean).join(' · ');
}

// ---------- actions ----------

async function refreshState() {
  const r = await api.state();
  if (!r.ok) return;
  state.app = r.data;
  state.layout = r.data.settings.view || 'grid';
}

async function refreshBin() {
  const r = await api.currentBin();
  state.bin = r.ok ? r.data : null;
}

function go(view) {
  state.view = view;
  state.selection.clear();
  state.detailId = null;
  if (view === 'browse' && !state.browse.loaded) loadBrowse();
  if (view === 'search' || view === 'browse') refreshBin().then(render);
  render();
}

async function runSearch(page = 1) {
  const s = state.search;
  s.loading = true;
  s.error = null;
  if (page === 1) {
    state.selection.clear();
    state.detailId = null;
  }
  render();
  const r = await api.search({ params: { query: s.query.trim(), type: s.type, date: s.date, duration: s.duration }, page });
  s.loading = false;
  s.ran = true;
  if (r.ok) {
    s.items = page === 1 ? r.data.items : s.items.concat(r.data.items);
    s.total = r.data.total;
    s.page = page;
  } else {
    s.error = r.error;
  }
  render();
}

async function loadBrowse() {
  const b = state.browse;
  b.loaded = true;
  const [saved, cols] = await Promise.all([api.savedSearches(), api.collections()]);
  b.saved = saved.ok ? saved.data : [];
  b.collections = cols.ok ? cols.data : [];
  b.error = [saved, cols].filter((r) => !r.ok).map((r) => r.error).join(' · ') || null;
  render();
}

async function openTarget(target, page = 1) {
  const b = state.browse;
  if (page === 1) {
    b.target = target;
    b.items = [];
    state.selection.clear();
    state.detailId = null;
  }
  b.loading = true;
  b.error = null;
  render();
  const r = target.kind === 'saved' ? await api.runSaved({ id: target.id, page }) : await api.collectionItems({ id: target.id, page });
  b.loading = false;
  if (r.ok) {
    b.items = page === 1 ? r.data.items : b.items.concat(r.data.items);
    b.total = r.data.total;
    b.page = page;
  } else {
    b.error = r.error;
  }
  render();
}

function toggleSelect(id, e) {
  if (e && (e.metaKey || e.ctrlKey || e.shiftKey)) {
    if (state.selection.has(id)) state.selection.delete(id);
    else state.selection.add(id);
  } else if (state.selection.size === 1 && state.selection.has(id)) {
    state.selection.clear();
  } else {
    state.selection.clear();
    state.selection.add(id);
  }
  if (state.detailId) state.detailId = id;
  render();
}

function selectAll() {
  for (const i of visibleItems()) state.selection.add(i.id);
  render();
}

function visibleItems() {
  const list = currentList();
  return state.view === 'search' && state.search.onlyMounted ? list.items.filter(originalOk) : list.items;
}

function showToast(toast) {
  state.toast = toast;
  render();
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    state.toast = null;
    render();
  }, toast.warn ? 9000 : 5000);
}

// Entry point for every import button. Asks about unreachable files first.
function requestImport(items, linkProxy) {
  if (!state.app.resolve.available) {
    showToast({ warn: true, text: state.app.resolve.reason });
    return;
  }
  const bad = items.filter((i) => !originalOk(i));
  if (!bad.length) return doImport(items.map((i) => i.id), linkProxy, false);
  state.dialog = { items, bad, linkProxy, proxyFallback: false };
  render();
}

async function doImport(ids, linkProxy, proxyOnlyFallback) {
  state.dialog = null;
  state.importing = { index: 0, total: ids.length, title: '' };
  render();
  const r = await api.importItems({ ids, linkProxy, proxyOnlyFallback });
  state.importing = null;
  if (!r.ok) return showToast({ warn: true, text: r.error });
  const s = r.data;
  const parts = [];
  if (s.imported) parts.push(`${s.imported} clip${s.imported === 1 ? '' : 's'} imported`);
  if (s.imported && linkProxy) parts.push(`${s.proxiesLinked} prox${s.proxiesLinked === 1 ? 'y' : 'ies'} linked`);
  if (s.skippedExisting) parts.push(`${s.skippedExisting} already in this bin, skipped`);
  if (!parts.length) parts.push('Nothing imported');
  const issues = s.failed.concat(s.warnings);
  showToast({ warn: issues.length > 0, text: parts.join(', '), issues });
}

async function importCollection() {
  const t = state.browse.target;
  state.importing = { index: 0, total: 0, title: 'Loading collection…' };
  render();
  const r = await api.collectionAll({ id: t.id });
  state.importing = null;
  if (!r.ok) return showToast({ warn: true, text: r.error });
  if (!r.data.length) return showToast({ warn: true, text: 'The collection is empty' });
  requestImport(r.data, true);
}

async function saveSettings(partial) {
  const r = await api.saveSettings(partial);
  if (r.ok) {
    state.app.settings = r.data;
    state.settingsUi.saved = true;
    state.settingsUi.error = null;
    clearTimeout(saveSettings.timer);
    saveSettings.timer = setTimeout(() => {
      state.settingsUi.saved = false;
      render();
    }, 1500);
  } else {
    state.settingsUi.error = r.error;
  }
  render();
}

function loadThumb(img, item) {
  if (!item.thumbnail) return;
  if (thumbs.has(item.id)) {
    const v = thumbs.get(item.id);
    if (v) img.src = v;
    else img.remove();
    return;
  }
  thumbs.set(item.id, null);
  api.thumbnail(item.id).then((r) => {
    const v = r.ok ? r.data : null;
    thumbs.set(item.id, v);
    if (v) img.src = v;
  });
}

// ---------- views ----------

function header() {
  const s = state.app.settings;
  const tab = (view, label) => h('button', { class: 'tab' + (state.view === view ? ' active' : ''), onClick: () => go(view) }, label);
  const r = state.app.resolve;
  return h(
    'header',
    { class: 'header' },
    h('div', { class: 'brand' }, h('b', null, 'Portal'), h('span', null, 'for Resolve')),
    h('nav', { class: 'tabs' }, tab('search', 'Search'), tab('browse', 'Browse')),
    h('div', { class: 'grow' }),
    h('div', { class: 'status', title: r.available ? s.baseUrl : r.reason }, h('span', { class: 'dot' + (r.available ? '' : ' warn') }), h('span', null, r.available ? 'Connected' : 'Resolve not connected')),
    h('button', { class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings', onClick: () => go('settings') }, icon('gear', 18, 1.8)),
  );
}

function thumb(item, { big } = {}) {
  const typeIcon = item.mediaType === 'audio' ? 'audio' : item.mediaType === 'image' ? 'image' : 'film';
  const el = h('div', { class: 'thumb' }, icon(typeIcon, big ? 40 : 34, 1.5));
  if (item.thumbnail) {
    const img = h('img', { alt: '' });
    el.append(img);
    loadThumb(img, item);
  }
  return el;
}

function tile(item) {
  const sel = state.selection.has(item.id);
  const off = offlineLabel(item);
  const t = thumb(item);
  if (proxyOk(item)) t.append(h('span', { class: 'badge proxy' }, 'PROXY'));
  if (off) t.append(h('span', { class: 'badge off' }, off.toUpperCase()));
  if (item.duration != null) t.append(h('span', { class: 'badge dur' }, fmtDuration(item.duration)));
  if (sel) t.append(h('span', { class: 'badge check' }, icon('check', 12, 3)));
  return h(
    'button',
    {
      class: 'tile' + (sel ? ' selected' : '') + (off ? ' offline' : ''),
      'aria-pressed': sel ? 'true' : 'false',
      title: item.title,
      onClick: (e) => toggleSelect(item.id, e),
      onDblclick: () => {
        state.detailId = item.id;
        render();
      },
    },
    t,
    h('div', { class: 'tile-title' }, item.title),
    h('div', { class: 'tile-meta' }, metaLine(item)),
  );
}

function listRow(item) {
  const sel = state.selection.has(item.id);
  const off = offlineLabel(item);
  return h(
    'button',
    {
      class: 'list-row' + (sel ? ' selected' : '') + (off ? ' offline' : ''),
      'aria-pressed': sel ? 'true' : 'false',
      onClick: (e) => toggleSelect(item.id, e),
      onDblclick: () => {
        state.detailId = item.id;
        render();
      },
    },
    thumb(item),
    h('span', { style: 'min-width:0' }, h('span', { class: 't', style: 'display:block' }, item.title), h('span', { class: 'muted', style: 'display:block;font-size:11px' }, fmtDate(item.created))),
    h('span', { class: 'mono', style: 'font-size:12px' }, fmtDuration(item.duration)),
    h('span', { style: 'color:var(--text-2);font-size:12px' }, item.resolution || item.mediaType || ''),
    h('span', { class: 'pills' }, proxyOk(item) && h('span', { class: 'pill proxy' }, 'PROXY'), off && h('span', { class: 'pill off' }, off.toUpperCase())),
  );
}

function resultsView(list, items, loadMore, emptyText) {
  const wrap = h('div', { class: 'results' });
  if (list.error) wrap.append(h('div', { class: 'error-box' }, icon('alert', 16), h('span', null, list.error)));
  // Every item failing the same way is a configuration problem, not a per-item one: say it once.
  const failed = items.filter((i) => i.error);
  if (items.length && failed.length === items.length) {
    wrap.append(h('div', { class: 'error-box', style: 'margin-bottom:16px' }, icon('alert', 16), h('span', null, `File locations could not be loaded from Portal: ${failed[0].error}`)));
  }
  if (!items.length && !list.loading && !list.error) wrap.append(h('div', { class: 'empty' }, emptyText));
  if (items.length) {
    if (state.layout === 'list') {
      wrap.append(h('div', { class: 'list' }, h('div', { class: 'list-row head' }, h('span'), h('span', null, 'Title'), h('span', null, 'Duration'), h('span', null, 'Format'), h('span', null, 'Status')), items.map(listRow)));
    } else {
      wrap.append(h('div', { class: 'grid' }, items.map(tile)));
    }
  }
  if (list.loading) wrap.append(h('div', { class: 'empty' }, 'Loading…'));
  else if (list.items.length < list.total) wrap.append(h('div', { class: 'more' }, h('button', { class: 'btn small', onClick: loadMore }, `Load more (${list.items.length} of ${list.total})`)));
  return wrap;
}

function layoutToggle() {
  const set = (v) => {
    state.layout = v;
    api.saveSettings({ view: v });
    render();
  };
  return h(
    'div',
    { class: 'seg' },
    h('button', { class: state.layout === 'grid' ? 'on' : '', 'aria-label': 'Grid view', 'aria-pressed': String(state.layout === 'grid'), onClick: () => set('grid') }, icon('grid', 14)),
    h('button', { class: state.layout === 'list' ? 'on' : '', 'aria-label': 'List view', 'aria-pressed': String(state.layout === 'list'), onClick: () => set('list') }, icon('list', 14)),
  );
}

function chipSelect(label, key, options) {
  const s = state.search;
  return h(
    'label',
    { class: 'chip' + (s[key] !== 'any' ? ' on' : '') },
    h('span', { class: 'sr-only' }, label),
    h(
      'select',
      {
        onChange: (e) => {
          s[key] = e.target.value;
          runSearch();
        },
      },
      options.map(([v, text]) => h('option', { value: v, selected: s[key] === v ? true : null }, `${label}: ${text}`)),
    ),
    icon('down', 12),
  );
}

function footer() {
  const items = visibleItems().filter((i) => state.selection.has(i.id));
  const n = items.length;
  const imp = state.importing;
  const disabled = !n || !!imp;
  const info = imp
    ? h(
        'div',
        { class: 'footer-info' },
        h('span', { style: 'font-weight:500' }, imp.total ? `Importing ${Math.min(imp.index + 1, imp.total)} of ${imp.total}… ${imp.title || ''}` : imp.title),
        h('div', { class: 'progress' }, h('div', { style: `width:${imp.total ? Math.round((imp.index / imp.total) * 100) : 5}%` })),
      )
    : h(
        'div',
        { class: 'footer-info' },
        h('span', { style: 'font-weight:500' }, n ? `${n} clip${n === 1 ? '' : 's'} selected` : 'Select clips to import'),
        h('span', { class: 'bin' }, icon('folder', 13), state.app.resolve.available ? `Into current bin: ${state.bin || '…'}` : state.app.resolve.reason),
      );
  return h(
    'footer',
    { class: 'footer' },
    info,
    !imp && n === 0 && visibleItems().length > 0 && h('button', { class: 'btn ghost small', onClick: selectAll }, 'Select all'),
    h('button', { class: 'btn', disabled, onClick: () => requestImport(items, false) }, 'Import original'),
    h('button', { class: 'btn primary', disabled, onClick: () => requestImport(items, true) }, icon('link', 14), 'Import + link proxy'),
  );
}

function fileCard(label, sub, f) {
  const ok = f && f.status === 'found';
  return h(
    'div',
    { class: 'file-card' },
    h(
      'div',
      { class: 'row' },
      h('span', { style: 'font-weight:500' }, label),
      h('span', { class: 'muted', style: 'font-size:11px' }, sub),
      h('div', { class: 'grow' }),
      h('span', { class: 'state ' + (ok ? 'ok' : 'bad') }, ok ? icon('check', 12, 3) : icon('alert', 12, 2.5), ok ? 'FOUND' : statusLabel(f).toUpperCase()),
    ),
    f && (f.localPath || f.portalPath) && h('span', { class: 'path' }, f.localPath || f.portalPath),
    f && f.detail && !ok && h('span', { class: 'muted', style: 'font-size:12px' }, f.detail),
    f && f.status === 'not_mounted' && h('span', { class: 'muted', style: 'font-size:12px' }, 'Mounted under another name here? ', h('button', { class: 'link-btn', onClick: () => go('settings') }, 'Add a path rewrite')),
    ok && h('div', null, h('button', { class: 'link-btn', onClick: () => api.reveal(f.localPath) }, 'Show in folder')),
  );
}

function drawer(item) {
  const s = state.app.settings;
  const close = () => {
    state.detailId = null;
    render();
  };
  const t = thumb(item, { big: true });
  if (item.duration != null) t.append(h('span', { class: 'badge dur' }, fmtDuration(item.duration)));
  return h(
    'aside',
    { class: 'drawer', 'aria-label': 'Item details' },
    h('div', { class: 'drawer-head' }, h('span', { class: 'label' }, 'Item'), h('button', { class: 'icon-btn', 'aria-label': 'Close details', onClick: close }, icon('close', 16))),
    h(
      'div',
      { class: 'drawer-body' },
      t,
      h('div', null, h('h2', null, item.title), item.description && h('p', null, item.description)),
      item.error && h('div', { class: 'error-box' }, icon('alert', 16), h('span', null, item.error)),
      h(
        'div',
        { class: 'kv' },
        h('span', null, 'Portal ID'),
        h('span', { class: 'mono' }, item.id),
        item.created && [h('span', null, 'Created'), h('span', null, fmtDateTime(item.created))],
        (item.resolution || item.codec) && [h('span', null, 'Format'), h('span', null, [item.resolution, item.codec].filter(Boolean).join(' · '))],
        item.mediaType && [h('span', null, 'Type'), h('span', null, item.mediaType)],
      ),
      h(
        'div',
        { style: 'display:flex;flex-direction:column;gap:8px' },
        h('span', { class: 'label' }, 'Files on this machine'),
        fileCard('Original', (item.original && item.original.shape) || '', item.original),
        fileCard('Proxy', (item.proxy && item.proxy.shape) || '', item.proxy),
      ),
    ),
    h(
      'div',
      { class: 'drawer-actions' },
      h('div', null, h('button', { class: 'link-btn', onClick: () => api.openInPortal(item.id) }, 'Open in Portal', icon('external', 12))),
      h(
        'div',
        { class: 'drawer-buttons' },
        h('button', { class: 'btn', disabled: !!state.importing, onClick: () => requestImport([item], false) }, 'Import original'),
        h('button', { class: 'btn primary', disabled: !!state.importing, onClick: () => requestImport([item], true) }, icon('link', 14), 'Import + link proxy'),
      ),
    ),
  );
}

function searchView() {
  const s = state.search;
  const input = h('input', {
    type: 'search',
    value: s.query,
    placeholder: 'Search titles, descriptions, filenames…',
    'aria-label': 'Search Portal',
    onInput: (e) => {
      s.query = e.target.value;
    },
    onKeydown: (e) => {
      if (e.key === 'Enter') runSearch();
    },
  });
  setTimeout(() => {
    if (!s.ran) input.focus();
  });
  const items = visibleItems();
  const detail = state.detailId && findItem(state.detailId);
  return [
    h(
      'div',
      { class: 'toolbar' },
      h('label', { class: 'searchbox' }, icon('search', 16), input, h('span', { class: 'kbd' }, '↵')),
      h(
        'div',
        { class: 'filters' },
        chipSelect('Type', 'type', [['any', 'Any'], ['video', 'Video'], ['audio', 'Audio'], ['image', 'Image']]),
        chipSelect('Date', 'date', [['any', 'Any'], ['24h', 'Last 24 h'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']]),
        chipSelect('Duration', 'duration', [['any', 'Any'], ['short', 'Under 1 min'], ['medium', '1–10 min'], ['long', 'Over 10 min']]),
        h(
          'button',
          {
            class: 'chip' + (s.onlyMounted ? ' on' : ''),
            'aria-pressed': String(s.onlyMounted),
            onClick: () => {
              s.onlyMounted = !s.onlyMounted;
              render();
            },
          },
          'Only on mounted storage',
        ),
        h('div', { class: 'grow' }),
        s.ran && h('span', { class: 'muted', style: 'font-size:12px' }, `${s.total} result${s.total === 1 ? '' : 's'}`),
        layoutToggle(),
      ),
    ),
    h('div', { class: 'body' }, resultsView(s, items, () => runSearch(s.page + 1), s.ran ? 'No results' : 'Search Portal to find media'), detail && drawer(detail)),
    footer(),
  ];
}

function buildTree(cols) {
  const ids = new Set(cols.map((c) => c.id));
  const kids = new Map();
  for (const c of cols) {
    const p = c.parent && ids.has(c.parent) ? c.parent : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(c);
  }
  return kids;
}

function browseView() {
  const b = state.browse;
  const kids = buildTree(b.collections);
  const filter = b.filter.trim().toLowerCase();
  const rows = [];
  const walk = (parent, depth, trail) => {
    for (const c of kids.get(parent) || []) {
      const hasKids = kids.has(c.id);
      const open = b.open.has(c.id) || !!filter;
      const path = [...trail, c.title || c.id];
      if (!filter || (c.title || '').toLowerCase().includes(filter)) {
        const on = b.target && b.target.kind === 'collection' && b.target.id === c.id;
        rows.push(
          h(
            'button',
            {
              class: 'side-item' + (on ? ' on' : ''),
              style: `padding-left:${8 + depth * 16}px`,
              onClick: () => {
                if (hasKids) b.open.has(c.id) ? b.open.delete(c.id) : b.open.add(c.id);
                openTarget({ kind: 'collection', id: c.id, name: c.title || c.id, trail });
              },
            },
            h('span', { class: 'chev' }, hasKids ? icon(open ? 'down' : 'right', 12, 2.5) : ''),
            icon('folder', 14),
            h('span', { class: 'name' }, c.title || c.id),
          ),
        );
      }
      if (hasKids && open) walk(c.id, depth + 1, path);
    }
  };
  walk(null, 0, []);
  const t = b.target;
  const detail = state.detailId && findItem(state.detailId);
  return [
    h(
      'div',
      { class: 'body' },
      h(
        'nav',
        { class: 'sidebar', 'aria-label': 'Collections and saved searches' },
        h(
          'div',
          { class: 'side-group' },
          h('span', { class: 'label' }, 'Saved searches'),
          b.loaded && !b.saved.length && h('span', { class: 'muted', style: 'padding:0 8px;font-size:12px' }, 'None'),
          b.saved.map((s) =>
            h('button', { class: 'side-item' + (t && t.kind === 'saved' && t.id === s.id ? ' on' : ''), onClick: () => openTarget({ kind: 'saved', id: s.id, name: s.name, trail: [] }) }, icon('bookmark', 14), h('span', { class: 'name' }, s.name)),
          ),
        ),
        h(
          'div',
          { class: 'side-group' },
          h('span', { class: 'label' }, 'Collections'),
          h(
            'label',
            { class: 'side-filter' },
            icon('search', 13),
            h('input', {
              type: 'search',
              placeholder: 'Filter collections',
              'aria-label': 'Filter collections',
              value: b.filter,
              onInput: (e) => {
                b.filter = e.target.value;
                const pos = e.target.selectionStart;
                render();
                const again = document.querySelector('.side-filter input');
                if (again) {
                  again.focus();
                  again.setSelectionRange(pos, pos);
                }
              },
            }),
          ),
          !b.loaded || (!b.collections.length && !b.error) ? h('span', { class: 'muted', style: 'padding:0 8px;font-size:12px' }, b.loaded ? 'No collections' : 'Loading…') : rows,
        ),
      ),
      h(
        'section',
        { class: 'content' },
        t
          ? h(
              'div',
              { class: 'content-head' },
              h('div', { class: 'grow', style: 'display:flex;flex-direction:column;gap:2px;min-width:0' }, h('span', { class: 'crumb' }, t.kind === 'saved' ? 'Saved search' : t.trail.length ? t.trail.join(' › ') + ' ›' : 'Collection'), h('span', { class: 'name' }, t.name)),
              t.kind === 'collection' && h('button', { class: 'btn small', disabled: !!state.importing, onClick: importCollection }, 'Import whole collection'),
              layoutToggle(),
            )
          : null,
        h('div', { class: 'body' }, resultsView(b, b.items, () => openTarget(t, b.page + 1), t ? 'Nothing here' : 'Pick a saved search or collection'), detail && drawer(detail)),
        footer(),
      ),
    ),
  ];
}

function loginView() {
  const s = state.app.settings;
  const l = state.login;
  const submit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    l.busy = true;
    l.error = null;
    render();
    const r = await api.login({ baseUrl: String(f.get('url')).trim(), username: String(f.get('user')).trim(), password: String(f.get('pass')), remember: f.get('remember') === 'on' });
    l.busy = false;
    if (!r.ok) {
      l.error = r.error;
      render();
      return;
    }
    await refreshState();
    go('search');
  };
  return h(
    'div',
    { class: 'center' },
    h(
      'form',
      { class: 'card', onSubmit: submit },
      h('div', { style: 'display:flex;flex-direction:column;gap:4px' }, h('div', { class: 'brand' }, h('b', null, 'Portal'), h('span', null, 'for Resolve')), h('p', null, 'Sign in to Cantemo Portal to search and import media from mounted storage.')),
      h('label', { class: 'field' }, h('span', null, 'Portal URL'), h('input', { class: 'input mono', name: 'url', type: 'url', required: true, placeholder: 'https://portal.example.com', value: s.baseUrl })),
      h('label', { class: 'field' }, h('span', null, 'Username'), h('input', { class: 'input', name: 'user', required: true, autocomplete: 'username', value: s.username })),
      h('label', { class: 'field' }, h('span', null, 'Password'), h('input', { class: 'input', name: 'pass', type: 'password', required: true, autocomplete: 'current-password' })),
      h(
        'label',
        { class: 'check', style: 'color:var(--text-2)' },
        h('input', { type: 'checkbox', name: 'remember', checked: s.rememberPassword && state.app.canEncrypt, disabled: !state.app.canEncrypt }),
        h('span', null, state.app.canEncrypt ? (state.app.platform === 'win32' ? 'Remember password (Windows Credential protection)' : 'Remember password in Keychain') : 'Password storage unavailable on this system'),
      ),
      h('button', { class: 'btn primary', type: 'submit', disabled: l.busy }, l.busy ? 'Connecting…' : 'Connect'),
      l.error && h('div', { class: 'error-box', role: 'alert' }, icon('alert', 16), h('span', null, l.error)),
    ),
  );
}

function settingsView() {
  const s = state.app.settings;
  const ui = state.settingsUi;
  const osKey = state.app.platform === 'win32' ? 'win' : 'mac';
  const rules = (s.rewrites || []).map((r) => ({ ...r }));
  const commit = () => saveSettings({ rewrites: rules });
  const testAll = async () => {
    const r = await api.testPaths(rules);
    if (r.ok) ui.tests = Object.fromEntries(r.data.map((t, i) => [i, t.status]));
    render();
  };
  const row = (r, i) => {
    const t = ui.tests[i];
    const [label, cls] = t === 'found' ? ['✓ Found', 'ok'] : t === 'not_mounted' ? ['Not mounted', 'bad'] : ['', ''];
    const edit = (key) => (e) => {
      r[key] = e.target.value.trim();
      ui.tests = {};
      commit();
    };
    return h(
      'div',
      { class: 'map-row rewrite' },
      h('input', { class: 'input mono', 'aria-label': 'Portal path prefix', placeholder: osKey === 'win' ? '\\\\10.0.0.1\\isilon' : '/Volumes/Isilon', value: r.from || '', onChange: edit('from') }),
      h('input', { class: 'input mono' + (cls === 'bad' ? ' bad' : ''), 'aria-label': 'Local path prefix', placeholder: osKey === 'win' ? 'I:\\' : '/Volumes/Isilon-1', value: r.to || '', onChange: edit('to') }),
      h('span', { class: 'map-status ' + cls }, label),
      h(
        'button',
        {
          class: 'icon-btn',
          'aria-label': `Remove rewrite ${r.from || ''}`,
          onClick: () => {
            rules.splice(i, 1);
            ui.tests = {};
            commit();
          },
        },
        icon('close', 14),
      ),
    );
  };
  const text = (key, label, placeholder) =>
    h('label', { class: 'field' }, h('span', null, label), h('input', { class: 'input mono', placeholder, value: s[key] || '', onChange: (e) => saveSettings({ [key]: e.target.value.trim() }) }));
  const check = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s[key], onChange: (e) => saveSettings({ [key]: e.target.checked }) }), h('span', null, label));
  return [
    h(
      'header',
      { class: 'header', style: 'gap:12px' },
      h('button', { class: 'icon-btn', 'aria-label': 'Back to search', onClick: () => go('search') }, icon('back', 16)),
      h('b', { style: 'font-size:15px' }, 'Settings'),
      h('div', { class: 'grow' }),
      ui.saved && h('span', { class: 'saved-note' }, 'Saved'),
    ),
    h(
      'div',
      { class: 'settings' },
      ui.error && h('div', { class: 'error-box' }, icon('alert', 16), h('span', null, ui.error)),
      h(
        'section',
        { class: 'section' },
        h('h2', null, 'Connection'),
        h(
          'div',
          { class: 'conn' },
          h('span', { class: 'dot' }),
          h('div', { class: 'grow', style: 'display:flex;flex-direction:column;gap:2px;min-width:0' }, h('span', { class: 'mono', style: 'font-size:12px' }, s.baseUrl), h('span', { class: 'muted', style: 'font-size:12px' }, `Signed in as ${s.username}`)),
          h(
            'button',
            {
              class: 'btn ghost small',
              onClick: async () => {
                await api.logout();
                await refreshState();
                state.search.items = [];
                state.browse = { ...state.browse, saved: [], collections: [], items: [], loaded: false, target: null };
                state.view = 'login';
                render();
              },
            },
            'Sign out',
          ),
        ),
      ),
      h(
        'section',
        { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', null, 'Path rewrites'), rules.length > 0 && h('button', { class: 'btn small', onClick: testAll }, 'Test paths')),
        h('p', { class: 'hint' }, 'Portal sends each file’s path as mounted on editing machines (set in Portal’s NLE settings). If a share is mounted under a different name on this machine, rewrite the start of the path here. Most machines need no rules.'),
        h(
          'div',
          { class: 'map-table' },
          rules.length > 0 && h('div', { class: 'map-row rewrite head' }, h('span', null, 'Portal path starts with'), h('span', null, 'On this machine'), h('span', null, 'Status'), h('span')),
          rules.map(row),
          h(
            'div',
            { class: 'map-row', style: 'grid-template-columns:1fr' },
            h(
              'button',
              {
                class: 'btn ghost small',
                style: 'justify-self:start',
                onClick: () => {
                  rules.push({ from: '', to: '' });
                  commit();
                },
              },
              '+ Add rewrite',
            ),
          ),
        ),
      ),
      h(
        'section',
        { class: 'section' },
        h('h2', null, 'Import'),
        text('descriptionField', 'Description metadata field (optional, e.g. portal_mf123456)', 'portal_mf…'),
        check('skipExisting', 'Skip clips already in the current bin (matched on Portal ID)'),
        check('writeMetadata', 'Write title and description to clip metadata (Portal ID always goes to Comments)'),
      ),
    ),
  ];
}

function dialogView(d) {
  const good = d.items.filter(originalOk);
  const fallback = d.bad.filter(proxyOk);
  const count = good.length + (d.proxyFallback ? fallback.length : 0);
  const close = () => {
    state.dialog = null;
    render();
  };
  return h(
    'div',
    { class: 'scrim' },
    h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-title' },
      h('div', { class: 'dialog-title' }, h('span', { style: 'color:var(--warn);display:flex' }, icon('alert', 20)), h('h2', { id: 'dlg-title' }, `${d.bad.length} of ${d.items.length} clip${d.items.length === 1 ? '' : 's'} can’t be reached`)),
      h('p', null, good.length ? 'These files aren’t on any mounted storage on this machine. The rest can be imported now.' : 'None of the selected files are on mounted storage on this machine.'),
      h(
        'div',
        { class: 'problems' },
        d.bad.slice(0, 50).map((item) => {
          const p = problemReason(item);
          return h(
            'div',
            { class: 'problem' },
            h('div', { style: 'display:flex;gap:8px;align-items:baseline' }, h('span', { style: 'font-weight:500;word-break:break-all' }, item.title), h('span', { class: 'why' }, p.why)),
            h('span', { class: p.link ? '' : 'mono', style: `font-size:${p.link ? 12 : 11}px;color:var(--text-2);word-break:break-all` }, p.text, p.link && ' ', p.link && h('button', { class: 'link-btn', onClick: () => { state.dialog = null; go('settings'); } }, 'Add path rewrite')),
          );
        }),
        d.bad.length > 50 && h('div', { class: 'problem muted' }, `…and ${d.bad.length - 50} more`),
      ),
      fallback.length > 0 &&
        h(
          'label',
          { class: 'check', style: 'color:var(--text-2)' },
          h('input', {
            type: 'checkbox',
            checked: d.proxyFallback,
            onChange: (e) => {
              d.proxyFallback = e.target.checked;
              render();
            },
          }),
          h('span', null, `Import the proxy instead where the original is missing (${fallback.length})`),
        ),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'btn ghost', onClick: close }, 'Cancel'),
        h(
          'button',
          {
            class: 'btn primary',
            disabled: count === 0,
            onClick: () => {
              const ids = good.map((i) => i.id).concat(d.proxyFallback ? fallback.map((i) => i.id) : []);
              doImport(ids, d.linkProxy, d.proxyFallback);
            },
          },
          `Import ${count} available`,
        ),
      ),
    ),
  );
}

function toastView(t) {
  return h(
    'div',
    { class: 'toast' + (t.warn ? ' warn' : ''), role: 'status' },
    icon(t.warn ? 'alert' : 'check', 14, t.warn ? 2 : 3),
    h('div', null, h('div', null, t.text), t.issues && t.issues.length > 0 && h('ul', null, t.issues.slice(0, 6).map((i) => h('li', null, `${i.title}: ${i.reason}`)), t.issues.length > 6 && h('li', null, `…and ${t.issues.length - 6} more`))),
  );
}

// ---------- render loop ----------

function render() {
  const root = document.getElementById('app');
  const scroller = root.querySelector('.results, .settings');
  const scrollTop = scroller ? scroller.scrollTop : 0;
  const prevView = render.lastView;
  root.replaceChildren();
  if (!state.app) return;
  if (state.view === 'login') root.append(loginView());
  else if (state.view === 'settings') root.append(...settingsView());
  else root.append(header(), ...(state.view === 'browse' ? browseView() : searchView()));
  if (state.dialog) root.append(dialogView(state.dialog));
  if (state.toast) root.append(toastView(state.toast));
  const next = root.querySelector('.results, .settings');
  if (next && prevView === state.view) next.scrollTop = scrollTop;
  render.lastView = state.view;
}

api.onImportProgress((p) => {
  if (!state.importing) return;
  state.importing = p.done ? null : { index: p.index, total: p.total, title: p.title };
  render();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state.dialog) state.dialog = null;
    else if (state.detailId) state.detailId = null;
    else return;
    render();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'a' && (state.view === 'search' || state.view === 'browse') && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    selectAll();
  }
});

(async () => {
  await refreshState();
  if (state.app.signedIn) {
    state.view = 'search';
    refreshBin().then(render);
  }
  render();
})();
