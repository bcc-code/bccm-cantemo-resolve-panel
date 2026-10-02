'use strict';

// Thin wrapper over Blackmagic's WorkflowIntegration.node. Every Resolve call is awaited:
// with GetResolvePromise (Resolve 20.1+) calls return promises, with GetResolve they are
// synchronous, and awaiting a plain value is harmless.

const path = require('path');

const PORTAL_TAG = 'portal:';

let WI = null;
let resolve = null;
let loadError = null;

function load(pluginDir) {
  try {
    WI = require(path.join(pluginDir, 'WorkflowIntegration.node'));
  } catch (err) {
    loadError = err;
    WI = null;
  }
}

async function init(pluginId) {
  if (!WI) return false;
  const ok = WI.InitializePromise ? await WI.InitializePromise(pluginId) : WI.Initialize(pluginId);
  if (!ok) return false;
  resolve = WI.GetResolvePromise ? await WI.GetResolvePromise() : WI.GetResolve();
  return !!resolve;
}

function available() {
  return !!resolve;
}

function unavailableReason() {
  if (resolve) return null;
  if (!WI) return 'Not running inside DaVinci Resolve Studio (WorkflowIntegration.node not loaded)';
  return 'Could not connect to DaVinci Resolve';
}

function cleanUp() {
  if (WI) WI.CleanUp();
}

async function mediaPool() {
  if (!resolve) throw new Error(unavailableReason());
  const pm = await resolve.GetProjectManager();
  const project = pm && (await pm.GetCurrentProject());
  if (!project) throw new Error('No project is open in Resolve');
  return project.GetMediaPool();
}

// "Master › Episode 12 › Footage" for the current Media Pool bin.
async function currentBinPath() {
  const pool = await mediaPool();
  const current = await pool.GetCurrentFolder();
  const targetId = await current.GetUniqueId();
  const walk = async (folder, trail) => {
    const name = await folder.GetName();
    const here = [...trail, name];
    if ((await folder.GetUniqueId()) === targetId) return here;
    for (const sub of (await folder.GetSubFolderList()) || []) {
      const found = await walk(sub, here);
      if (found) return found;
    }
    return null;
  };
  const trail = await walk(await pool.GetRootFolder(), []);
  return (trail || [await current.GetName()]).join(' › ');
}

async function portalIdsInCurrentBin() {
  const pool = await mediaPool();
  const folder = await pool.GetCurrentFolder();
  const ids = new Set();
  for (const clip of (await folder.GetClipList()) || []) {
    const meta = (await clip.GetMetadata()) || {};
    const comments = meta.Comments || '';
    const m = new RegExp(PORTAL_TAG + '(\\S+)').exec(comments);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// Imports one Portal item into the current bin.
// job: { id, title, description, mediaPath, proxyPath, writeMetadata }
// Returns { clip: true, proxyLinked: bool }.
async function importClip(job) {
  const pool = await mediaPool();
  // Plain paths, as in Blackmagic's samples. The documented clipInfo form ({ FilePath })
  // fails over the JavaScript bridge with "Invalid 'StartIndex' or 'EndIndex'".
  const imported = await pool.ImportMedia([job.mediaPath]);
  const clip = imported && imported[0];
  if (!clip) throw new Error(`Resolve could not import ${job.mediaPath}`);
  let proxyLinked = false;
  if (job.proxyPath) {
    proxyLinked = !!(await clip.LinkProxyMedia(job.proxyPath));
  }
  // The Portal ID is always written: it is how already-imported clips are recognised.
  const metadata = { Comments: PORTAL_TAG + job.id };
  if (job.writeMetadata) {
    if (job.title) await clip.SetClipProperty('Clip Name', job.title);
    if (job.description) metadata.Description = job.description;
  }
  await clip.SetMetadata(metadata);
  return { clip: true, proxyLinked };
}

module.exports = { load, init, available, unavailableReason, cleanUp, currentBinPath, portalIdsInCurrentBin, importClip, loadError: () => loadError };
