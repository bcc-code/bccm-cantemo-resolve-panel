'use strict';

// Cantemo Portal REST client. Uses only Portal's own API, the same endpoints Cantemo's
// Premiere panel and Agent use:
//   PUT /API/v2/search/            search, with metadata and thumbnail fields in the hits
//   GET /API/v2/items/nle_data/    local paths of original + proxy, mapped by Portal per OS
//   GET /API/v2/search/saved/      saved searches
//   /APInoauth/thumbnail/…?hash=   thumbnails (hash-signed URLs from the search hits)

// Search field names in Portal's index; adjust here if yours differ.
const FIELDS = {
  title: 'title',
  mediaType: 'mediaType',
  mimeType: 'mimeType',
  created: 'created',
  duration: 'durationSeconds',
  width: 'originalWidth',
  height: 'originalHeight',
  videoCodec: 'originalVideoCodec',
  format: 'originalFormat',
  filename: 'originalFilename',
  thumbnail: 'representativeThumbnailNoAuth',
  archived: 'is_archived',
  deleted: 'portal_deleted',
  parentCollection: 'parent_collection',
};

const RESULT_FIELDS = ['id', ...Object.values(FIELDS).filter((f) => f !== FIELDS.deleted)];

const DATE_RANGES = { '24h': 'now-1d', '7d': 'now-7d', '30d': 'now-30d' };
const DURATION_RANGES = { short: { max: '60' }, medium: { min: '60', max: '600' }, long: { min: '600' } };

class PortalError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function buildSearchDoc({ query, type, date, duration, collection } = {}, extraFields = []) {
  const terms = [{ name: FIELDS.deleted, missing: true }];
  if (type && type !== 'any') terms.push({ name: FIELDS.mediaType, value: type });
  if (DATE_RANGES[date]) terms.push({ name: FIELDS.created, range: { min: DATE_RANGES[date] } });
  if (DURATION_RANGES[duration]) terms.push({ name: FIELDS.duration, range: DURATION_RANGES[duration] });
  if (collection) terms.push({ name: FIELDS.parentCollection, value: collection });
  const doc = {
    doc_types: ['item'],
    fields: [...RESULT_FIELDS, ...extraFields],
    filter: { operator: 'AND', terms },
    sort: [query ? { name: '_relevance', order: 'desc' } : { name: FIELDS.created, order: 'desc' }],
  };
  if (query) doc.query = query;
  return doc;
}

function firstValue(v) {
  if (Array.isArray(v)) return firstValue(v[0]);
  if (v && typeof v === 'object' && 'value' in v) return firstValue(v.value);
  return v;
}

function toNumber(v) {
  const n = parseFloat(firstValue(v));
  return Number.isFinite(n) ? n : null;
}

function truthy(v) {
  const x = firstValue(v);
  return x === true || x === 'true' || x === 'True';
}

// One search hit -> item. Portal returns every field as an array.
function parseHit(r, { descriptionField } = {}) {
  const f = (name) => firstValue(r[name] ?? (r.fields || {})[name]);
  const mime = f(FIELDS.mimeType) || '';
  const width = toNumber(r[FIELDS.width]);
  const height = toNumber(r[FIELDS.height]);
  // Audio files often carry cover art, so Portal reports mediaType "video" for them.
  const mediaType = mime.startsWith('audio/') ? 'audio' : mime.startsWith('image/') ? 'image' : f(FIELDS.mediaType) || 'unknown';
  return {
    id: r.id || r.item_id || f('id'),
    title: f(FIELDS.title) || f(FIELDS.filename) || r.id,
    description: (descriptionField && f(descriptionField)) || '',
    mediaType,
    created: f(FIELDS.created) || null,
    duration: toNumber(r[FIELDS.duration]),
    resolution: mediaType !== 'audio' && width && height ? `${width}×${height}` : null,
    codec: mediaType === 'audio' ? f(FIELDS.format) || null : f(FIELDS.videoCodec) || null,
    archived: truthy(r[FIELDS.archived]),
    thumbnail: f(FIELDS.thumbnail) || null,
    parent: f(FIELDS.parentCollection) || null,
  };
}

// Portal search responses: { hits, results: [...] }.
function parseSearchResponse(json, opts) {
  const list = (json && (json.results || json.items)) || [];
  const total = typeof json.hits === 'number' ? json.hits : json.count ?? json.total ?? list.length;
  return { total, results: list.map((r) => parseHit(r, opts)).filter((r) => r.id) };
}

// GET /API/v2/items/nle_data/ -> { [id]: { original, proxy } } with Portal's file entries
// ({ shape_name, path, accessible, detail }).
function parseNleData(json) {
  const files = {};
  for (const it of (json && json.items) || []) {
    if (it.id) files[it.id] = { original: (it.files || {}).original || null, proxy: (it.files || {}).proxy || null };
  }
  return { files, proxyWorkflowEnabled: !!(json && json.proxy_workflow_enabled) };
}

function parseSavedSearches(json) {
  const list = Array.isArray(json) ? json : json.results || json.objects || json.saved_searches || [];
  return list.map((s) => ({ id: String(s.id), name: s.name || s.title || `Search ${s.id}` }));
}

class PortalClient {
  constructor({ baseUrl, username, password, fetch: fetchImpl, descriptionField } = {}) {
    this.baseUrl = trimSlash(baseUrl);
    this.auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    this.fetch = fetchImpl || globalThis.fetch;
    this.descriptionField = descriptionField || null;
  }

  async request(url, { method = 'GET', body, accept = 'application/json' } = {}) {
    const headers = { Authorization: this.auth, Accept: accept, 'X-Requested-With': 'XMLHttpRequest' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const target = new URL(url);
    const where = `${method} ${target.pathname}`;
    let res;
    try {
      res = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      throw new PortalError(`Cannot reach ${target.host}: ${err.message}`, 0);
    }
    // An access proxy in front of Portal (Entra application proxy, IAP, …) answers requests
    // without its cookie by redirecting to its sign-in page on another host.
    const finalUrl = res.url ? new URL(res.url) : target;
    const type = ((res.headers && res.headers.get('content-type')) || '').split(';')[0];
    if (finalUrl.origin !== target.origin || (res.status === 401 && type === 'text/html')) {
      const err = new PortalError(`${target.host} requires signing in to its access proxy (${finalUrl.host})`, res.status);
      err.code = 'GATEWAY_AUTH';
      err.origin = target.origin;
      throw err;
    }
    if (!res.ok) {
      const hint = res.status === 401 ? 'check username and password' : res.status === 403 ? 'access denied' : res.statusText;
      throw new PortalError(`${where} answered ${res.status} (${hint})`, res.status);
    }
    if (accept !== 'application/json') return res;
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      const title = /<title>([^<]*)<\/title>/i.exec(text);
      throw new PortalError(`${where} returned ${type || 'unknown type'}${title ? ` (“${title[1].trim()}”)` : ''} instead of JSON. Check the Portal URL and that this endpoint is available.`, res.status);
    }
  }

  portal(path, opts) {
    return this.request(this.baseUrl + path, opts);
  }

  whoami() {
    return this.portal('/API/v2/whoami/');
  }

  extraFields() {
    return this.descriptionField ? [this.descriptionField] : [];
  }

  async search(params = {}, { page = 1, pageSize = 50 } = {}) {
    const json = await this.portal(`/API/v2/search/?page=${page}&page_size=${pageSize}`, {
      method: 'PUT',
      body: buildSearchDoc(params, this.extraFields()),
    });
    return parseSearchResponse(json, { descriptionField: this.descriptionField });
  }

  async listSavedSearches() {
    return parseSavedSearches(await this.portal('/API/v2/search/saved/?page_size=1000'));
  }

  async runSavedSearch(id, { page = 1, pageSize = 50 } = {}) {
    const json = await this.portal(`/API/v2/search/saved/${encodeURIComponent(id)}/?page=${page}&page_size=${pageSize}`);
    return parseSearchResponse(json, { descriptionField: this.descriptionField });
  }

  // All collections as a flat list with parent ids, for the Browse tree.
  async listCollections({ max = 2000 } = {}) {
    const out = [];
    for (let page = 1; out.length < max; page++) {
      const json = await this.portal(`/API/v2/search/?page=${page}&page_size=200`, {
        method: 'PUT',
        body: {
          doc_types: ['collection'],
          fields: ['id', FIELDS.title, FIELDS.parentCollection],
          filter: { operator: 'AND', terms: [{ name: FIELDS.deleted, missing: true }] },
          sort: [{ name: FIELDS.title, order: 'asc' }],
        },
      });
      const { results, total } = parseSearchResponse(json);
      out.push(...results);
      if (!results.length || out.length >= total) break;
    }
    return out;
  }

  collectionItems(id, paging) {
    return this.search({ collection: id }, paging);
  }

  // Local paths for original + proxy as Portal maps them for `platform` ('mac' | 'win').
  async nleData(ids, platform) {
    if (!ids.length) return { files: {}, proxyWorkflowEnabled: false };
    const list = ids.map(encodeURIComponent).join(',');
    return parseNleData(await this.portal(`/API/v2/items/nle_data/?items=${list}&platform=${platform}`));
  }

  thumbnailUrl(uri) {
    if (!uri) return null;
    return uri.startsWith('/') ? this.baseUrl + uri : uri;
  }

  async fetchImage(uri) {
    const res = await this.request(this.thumbnailUrl(uri), { accept: 'image/*' });
    const type = res.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${buf.toString('base64')}`;
  }

  itemPageUrl(id) {
    return `${this.baseUrl}/item/${encodeURIComponent(id)}/`;
  }
}

module.exports = {
  PortalClient,
  PortalError,
  FIELDS,
  buildSearchDoc,
  parseSearchResponse,
  parseNleData,
  parseSavedSearches,
};
