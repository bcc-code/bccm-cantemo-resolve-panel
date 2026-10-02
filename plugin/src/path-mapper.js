'use strict';

// Turns the local paths Portal reports (GET /API/v2/items/nle_data/, already mapped by
// Portal's NLE settings for this OS) into paths on this machine, and checks them.
//
// Portal's mapping is per platform, not per machine, so an editor whose share is mounted
// under another name can add rewrite rules: { from: '/Volumes/Isilon', to: '/Volumes/Isilon-1' }.

const fs = require('fs');

function isWin(platform) {
  return platform === 'win32';
}

function norm(p, platform) {
  return isWin(platform) ? String(p).replace(/\//g, '\\') : String(p);
}

// Longest matching `from` prefix wins; it must end at a path separator boundary.
function applyRewrites(path, rules, platform = process.platform) {
  if (!path) return path;
  const p = norm(path, platform);
  const cmp = (s) => (isWin(platform) ? s.toLowerCase() : s);
  let best = null;
  for (const r of rules || []) {
    if (!r || !r.from || !r.to) continue;
    const from = norm(r.from, platform).replace(/[\\/]+$/, '');
    const next = p.charAt(from.length);
    if (cmp(p).startsWith(cmp(from)) && (next === '' || next === '/' || next === '\\')) {
      if (!best || from.length > best.from.length) best = { from, to: norm(r.to, platform).replace(/[\\/]+$/, '') };
    }
  }
  return best ? best.to + p.slice(best.from.length) : p;
}

// The volume a path lives on: /Volumes/<name>, \\server\share or a drive letter.
function mountRoot(path, platform = process.platform) {
  const p = norm(path, platform);
  if (isWin(platform)) {
    const unc = /^(\\\\[^\\]+\\[^\\]+)/.exec(p);
    if (unc) return unc[1];
    const drive = /^([A-Za-z]:\\?)/.exec(p);
    return drive ? drive[1].replace(/\\?$/, '\\') : null;
  }
  const vol = /^(\/Volumes\/[^/]+)/.exec(p);
  if (vol) return vol[1];
  const top = /^(\/[^/]+)/.exec(p);
  return top ? top[1] : null;
}

// file: one entry of nle_data `files` ({ shape_name, path, accessible, detail }).
// Returns { status, shape, localPath?, portalPath?, detail? } where status is
//   'none'         Portal has no such shape (detail says why)
//   'unavailable'  Portal says the file is not accessible, e.g. archived
//   'found'        the file exists on this machine
//   'missing'      the volume is mounted but the file is not there
//   'not_mounted'  the volume is not mounted on this machine
function resolveFile(file, rules, { platform = process.platform, exists = fs.existsSync } = {}) {
  if (!file || !file.path) return { status: 'none', shape: file && file.shape_name, detail: file && file.detail };
  const base = { shape: file.shape_name, portalPath: file.path, detail: file.detail };
  if (file.accessible === false) return { ...base, status: 'unavailable' };
  const localPath = applyRewrites(file.path, rules, platform);
  if (exists(localPath)) return { ...base, status: 'found', localPath };
  const root = mountRoot(localPath, platform);
  return { ...base, localPath, status: root && exists(root) ? 'missing' : 'not_mounted' };
}

// For the Settings "Test" button: is each rule's target mounted here?
function testRewrites(rules, { exists = fs.existsSync } = {}) {
  return (rules || []).map((r) => ({ from: r.from, to: r.to, status: r.to && exists(r.to) ? 'found' : 'not_mounted' }));
}

module.exports = { applyRewrites, mountRoot, resolveFile, testRewrites };
