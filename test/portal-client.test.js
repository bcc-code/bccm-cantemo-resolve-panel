'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PortalClient, buildSearchDoc, parseSearchResponse, parseNleData, parseSavedSearches } = require('../plugin/src/portal-client');

const jsonRes = (obj) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(obj) });

// Shapes as returned by BCC Media's Portal 5.4 (PUT /API/v2/search/ with fields, GET /API/v2/items/nle_data/).
const hits = {
  hits: 2,
  results: [
    {
      id: 'VX-276933',
      title: ['GREN_20171021_MUSIKAL_MAS_NOR.mov'],
      durationSeconds: ['93.4'],
      mediaType: ['video'],
      mimeType: ['video/quicktime'],
      originalWidth: ['1920'],
      originalHeight: ['1080'],
      originalVideoCodec: ['prores'],
      created: ['2017-10-21T10:00:00+02:00'],
      is_archived: ['false'],
      representativeThumbnailNoAuth: ['/APInoauth/thumbnail/VX-6/VX-276933;version=0/17500@PAL?hash=abc'],
      portal_mf111: ['A description'],
    },
    { id: 'VX-490496', title: ['BMM-101403 deu - Testing'], mediaType: ['video'], mimeType: ['audio/mpeg'], originalWidth: ['200'], originalHeight: ['200'], originalFormat: ['mp3'], is_archived: ['true'] },
  ],
};

const nle = {
  items: [
    {
      id: 'VX-490496',
      files: {
        original: { shape_name: 'original', path: '/Volumes/Isilon/raw/BMM-101403-deu.mp3', accessible: true },
        proxy: { shape_name: 'lowres_watermarked', detail: "Item does not have 'lowres_watermarked' shape", accessible: false },
      },
    },
  ],
  proxy_workflow_enabled: true,
};

test('parseSearchResponse flattens Portal field arrays', () => {
  const { total, results } = parseSearchResponse(hits, { descriptionField: 'portal_mf111' });
  assert.equal(total, 2);
  const [v, a] = results;
  assert.deepEqual(
    { title: v.title, duration: v.duration, resolution: v.resolution, codec: v.codec, archived: v.archived, description: v.description, thumbnail: v.thumbnail },
    { title: 'GREN_20171021_MUSIKAL_MAS_NOR.mov', duration: 93.4, resolution: '1920×1080', codec: 'prores', archived: false, description: 'A description', thumbnail: '/APInoauth/thumbnail/VX-6/VX-276933;version=0/17500@PAL?hash=abc' },
  );
  // mp3 with cover art: Portal says "video", the MIME type says audio
  assert.deepEqual([a.mediaType, a.resolution, a.codec, a.archived], ['audio', null, 'mp3', true]);
});

test('parseNleData keys files by item id', () => {
  const r = parseNleData(nle);
  assert.equal(r.proxyWorkflowEnabled, true);
  assert.equal(r.files['VX-490496'].original.path, '/Volumes/Isilon/raw/BMM-101403-deu.mp3');
  assert.equal(r.files['VX-490496'].proxy.accessible, false);
});

test('buildSearchDoc adds filters and requests the result fields', () => {
  const doc = buildSearchDoc({ query: 'fjord', type: 'video', date: '7d', duration: 'short' }, ['portal_mf111']);
  assert.equal(doc.query, 'fjord');
  assert.deepEqual(doc.filter.terms.map((t) => t.name), ['portal_deleted', 'mediaType', 'created', 'durationSeconds']);
  assert.ok(doc.fields.includes('representativeThumbnailNoAuth') && doc.fields.includes('portal_mf111'));
  assert.equal(buildSearchDoc({}).query, undefined);
});

test('parseSavedSearches accepts the saved_searches envelope', () => {
  assert.deepEqual(parseSavedSearches({ saved_searches: [{ id: 3, name: 'Mine' }] }), [{ id: '3', name: 'Mine' }]);
});

test('client sends basic auth, the search document and the nle_data query', async () => {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    return jsonRes(url.includes('nle_data') ? nle : hits);
  };
  const c = new PortalClient({ baseUrl: 'https://portal.test/', username: 'u', password: 'p', fetch });
  await c.search({ query: 'x' }, { page: 2, pageSize: 10 });
  assert.equal(calls[0].url, 'https://portal.test/API/v2/search/?page=2&page_size=10');
  assert.equal(calls[0].opts.method, 'PUT');
  assert.equal(calls[0].opts.headers.Authorization, 'Basic ' + Buffer.from('u:p').toString('base64'));
  assert.equal(JSON.parse(calls[0].opts.body).query, 'x');
  const r = await c.nleData(['VX-1', 'VX-2'], 'win');
  assert.equal(calls[1].url, 'https://portal.test/API/v2/items/nle_data/?items=VX-1,VX-2&platform=win');
  assert.ok(r.files['VX-490496']);
  assert.equal(c.thumbnailUrl('/APInoauth/thumbnail/x?hash=1'), 'https://portal.test/APInoauth/thumbnail/x?hash=1');
});

test('client surfaces HTTP errors with a hint', async () => {
  const fetch = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', headers: { get: () => 'application/json' } });
  const c = new PortalClient({ baseUrl: 'https://portal.test', username: 'u', password: 'bad', fetch });
  await assert.rejects(c.whoami(), /401 \(check username and password\)/);
});

test('client explains HTML answers and detects access-proxy redirects', async () => {
  const headers = (h) => ({ get: (k) => h[k.toLowerCase()] });
  const html = async () => ({ ok: true, status: 200, headers: headers({ 'content-type': 'text/html; charset=utf-8' }), text: async () => '<!DOCTYPE html><title>Login | Portal</title>' });
  const c1 = new PortalClient({ baseUrl: 'https://portal.test', username: 'u', password: 'p', fetch: html });
  await assert.rejects(c1.whoami(), /returned text\/html \(“Login \| Portal”\) instead of JSON/);
  const iap = async () => ({ ok: true, status: 200, redirected: true, url: 'https://login.microsoftonline.com/x/oauth2/authorize', headers: headers({ 'content-type': 'text/html' }), text: async () => '<!DOCTYPE html>' });
  const c2 = new PortalClient({ baseUrl: 'https://portal.test', username: 'u', password: 'p', fetch: iap });
  await assert.rejects(c2.whoami(), (err) => err.code === 'GATEWAY_AUTH' && err.origin === 'https://portal.test');
});
