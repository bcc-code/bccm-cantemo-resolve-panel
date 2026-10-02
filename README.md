# Portal for Resolve

A DaVinci Resolve Studio Workflow Integration plugin. It searches Cantemo Portal and imports media straight from shared storage that is mounted on the editing machine. Nothing is downloaded. Portal gives the path of each original and proxy as mounted on editing machines (the same mapping Cantemo's own Premiere panel uses). The plugin imports the original and attaches the proxy with Link Proxy Media.

- Search with filters (type, date, duration, only on mounted storage), in a grid or list view
- Browse Portal collections and saved searches, and import a whole collection
- An item detail panel showing the resolved local paths of the original and proxy files
- Import into the current Media Pool bin, as original only or original with linked proxy
- When an original isn't reachable, the plugin says why (archived, volume not mounted, file missing) and can import the proxy instead
- Writes title → Clip Name, description → Description, and `portal:<item id>` → Comments. Clips already in the bin are skipped.

> **Built for BCC Media.** This plugin is made for BCC Media's own setup: Cantemo Portal behind a Microsoft Entra access proxy, with Portal's NLE settings mapping the shared storage for editing machines. It is not a general-purpose product. Endpoints, field names and the sign-in flow follow that installation and may not work on other Portal setups without changes.
>
> **Portal version:** tested against Cantemo Portal 5.4 (matching Cantemo Panel and Agent 5.4.1). It has not been tested with Portal 6 yet.

## Requirements

- DaVinci Resolve Studio 19.0.2 or newer on macOS or Windows (tested against the 21.1 SDK). The free version of Resolve has no Workflow Integrations.
- A Cantemo Portal user (username + password). The plugin uses HTTP basic auth.
- Portal's NLE settings must define where storages are mounted on editing machines (per platform). Cantemo's Premiere panel and Agent rely on the same settings. Only Portal's own API is used (`/API/v2/...` and `/APInoauth/thumbnail/...`), so nothing needs to be opened up on the Vidispine side.

### Access proxy (IAP) in front of Portal

If Portal sits behind an identity-aware proxy (Microsoft Entra application proxy, Google IAP, Cloudflare Access, …), the plugin detects it: an API call gets redirected to another host's sign-in page. The plugin then opens a sign-in window. After you sign in, the proxy sets its cookie and the window closes by itself. All Portal requests share that cookie session. Proxies usually set a session-only cookie, so the plugin keeps a copy for 7 days (stored encrypted with the OS keychain) to avoid signing in every time the plugin opens. When the proxy stops accepting it, the window opens again. It stays hidden if the identity provider signs you in silently within a couple of seconds. **Sign out** clears the proxy cookies as well.

## Install

Quit Resolve first, or restart it afterwards. Resolve scans plugins only at startup.

macOS:

```sh
./scripts/install-mac.sh
```

Windows (elevated PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-win.ps1
```

The scripts copy `plugin/` into Resolve's `Workflow Integration Plugins` folder, along with the `WorkflowIntegration.node` that ships with your Resolve install. That file belongs to Blackmagic Design and is not part of this repo. Then open **Workspace → Workflow Integrations → Portal**.

## First run

1. Sign in with the Portal URL, username and password. The password is encrypted with the OS keychain (macOS Keychain, Windows DPAPI) via Electron `safeStorage`.
2. Search. Each result shows whether the original is on a mounted volume on this machine, and whether a proxy is available.
3. Optional: if a share is mounted under a different name on this machine than Portal expects (say `/Volumes/Isilon-1` instead of `/Volumes/Isilon`), add a **Path rewrite** in Settings.
4. Optional: to copy a description onto clips, set the Portal metadata field that holds it (for example `portal_mf123456`).

## How paths are resolved

The plugin calls the same endpoints as Cantemo's Premiere panel:

- `PUT /API/v2/search/` with `fields` returns the hits with their metadata (title, duration, size, codec, archive status) and a hash-signed thumbnail URL (`representativeThumbnailNoAuth`).
- `GET /API/v2/items/nle_data/?items=VX-1,VX-2&platform=mac|win` returns, for each item, the local path of the original and of Portal's configured proxy shape for this OS. It also says whether each file is accessible and, if not, why (for example archived, or the shape doesn't exist).

The plugin applies any path rewrites, then checks that the file exists. A missing file is reported as either "not mounted" (the volume itself is missing) or "missing" (the volume is there but the file isn't). Paths are checked again right before import.

## Development

```sh
npm install      # Electron, for running the UI outside Resolve
npm test         # unit tests (path mapping, Portal/Vidispine parsing)
npm run dev      # opens the plugin window without Resolve (imports disabled)
```

Layout:

```
plugin/
  manifest.xml            plugin id media.bcc.portal
  main.js                 Electron main: IPC, Portal, filesystem, Resolve
  preload.js              contextBridge API (renderer is sandboxed, context-isolated)
  renderer/               UI (plain DOM, no build step)
  src/portal-client.js    Portal /API/v2: search, saved searches, collections, nle_data, thumbnails
  src/path-mapper.js      per-machine path rewrites, mount and file checks
  src/resolve-bridge.js   WorkflowIntegration.node wrapper: import, link proxy, metadata
  src/settings.js         settings.json in userData, encrypted password
scripts/                  install scripts
test/                     node:test unit tests
```

Search field names (`title`, `durationSeconds`, `originalWidth`, `representativeThumbnailNoAuth`, `is_archived`, …) are in `FIELDS` in `plugin/src/portal-client.js`. Adjust them there if your Portal index uses different names.
