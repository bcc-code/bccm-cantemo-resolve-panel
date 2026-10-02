'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pm = require('../plugin/src/path-mapper');

const file = (path, extra = {}) => ({ shape_name: 'original', path, accessible: true, ...extra });
const fsWith = (existing) => (p) => existing.includes(p);

test('uses Portal paths unchanged without rules', () => {
  assert.equal(pm.applyRewrites('/Volumes/Isilon/raw/a.mov', [], 'darwin'), '/Volumes/Isilon/raw/a.mov');
});

test('rewrites the longest matching prefix on a path boundary', () => {
  const rules = [
    { from: '/Volumes/Isilon', to: '/Volumes/Isilon-1' },
    { from: '/Volumes/Isilon/raw', to: '/Volumes/Raw' },
  ];
  assert.equal(pm.applyRewrites('/Volumes/Isilon/raw/a.mov', rules, 'darwin'), '/Volumes/Raw/a.mov');
  assert.equal(pm.applyRewrites('/Volumes/Isilon/edit/a.mov', rules, 'darwin'), '/Volumes/Isilon-1/edit/a.mov');
  // "/Volumes/IsilonX" must not match "/Volumes/Isilon"
  assert.equal(pm.applyRewrites('/Volumes/IsilonX/a.mov', rules, 'darwin'), '/Volumes/IsilonX/a.mov');
});

test('rewrites UNC paths to drive letters on Windows, case-insensitively', () => {
  const rules = [{ from: '\\\\10.0.0.1\\isilon', to: 'I:\\' }];
  assert.equal(pm.applyRewrites('\\\\10.0.0.1\\Isilon\\raw\\a.mov', rules, 'win32'), 'I:\\raw\\a.mov');
});

test('finds the mount root', () => {
  assert.equal(pm.mountRoot('/Volumes/Isilon/raw/a.mov', 'darwin'), '/Volumes/Isilon');
  assert.equal(pm.mountRoot('\\\\10.0.0.1\\isilon\\raw\\a.mov', 'win32'), '\\\\10.0.0.1\\isilon');
  assert.equal(pm.mountRoot('I:\\raw\\a.mov', 'win32'), 'I:\\');
});

test('distinguishes found, missing and not mounted', () => {
  const f = file('/Volumes/Isilon/raw/a.mov');
  const opts = (existing) => ({ platform: 'darwin', exists: fsWith(existing) });
  assert.equal(pm.resolveFile(f, [], opts(['/Volumes/Isilon', '/Volumes/Isilon/raw/a.mov'])).status, 'found');
  assert.equal(pm.resolveFile(f, [], opts(['/Volumes/Isilon'])).status, 'missing');
  assert.equal(pm.resolveFile(f, [], opts([])).status, 'not_mounted');
});

test('passes on what Portal says about unavailable or absent shapes', () => {
  const archived = pm.resolveFile(file('/Volumes/Isilon/old/a.mov', { accessible: false, detail: 'File not accessible, item archive status Archived' }), [], { platform: 'darwin', exists: () => true });
  assert.equal(archived.status, 'unavailable');
  assert.match(archived.detail, /Archived/);
  const none = pm.resolveFile({ shape_name: 'lowres_watermarked', accessible: false, detail: "Item does not have 'lowres_watermarked' shape" }, [], { platform: 'darwin' });
  assert.deepEqual([none.status, none.shape], ['none', 'lowres_watermarked']);
  assert.equal(pm.resolveFile(null, []).status, 'none');
});

test('testRewrites reports whether each target is mounted', () => {
  const r = pm.testRewrites([{ from: '/a', to: '/Volumes/X' }, { from: '/b', to: '/Volumes/Y' }], { exists: fsWith(['/Volumes/X']) });
  assert.deepEqual(r.map((x) => x.status), ['found', 'not_mounted']);
});
