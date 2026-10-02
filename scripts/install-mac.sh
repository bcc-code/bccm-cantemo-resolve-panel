#!/usr/bin/env bash
# Installs Portal for Resolve into DaVinci Resolve Studio's Workflow Integration Plugins folder (macOS).
set -euo pipefail

PLUGIN_ID="media.bcc.portal"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../plugin" && pwd)"
DEST_ROOT="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins"
DEST="$DEST_ROOT/$PLUGIN_ID"

CANDIDATES=(
  "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node"
  "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Workflow Integration/WorkflowIntegration.node"
)

NODE=""
for c in "${CANDIDATES[@]}"; do
  if [ -f "$c" ]; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  echo "ERROR: WorkflowIntegration.node not found. Is DaVinci Resolve Studio installed?" >&2
  printf '  looked in:\n'; printf '    %s\n' "${CANDIDATES[@]}" >&2
  exit 1
fi


# Resolve usually leaves its support folder world-writable; fall back to sudo when it is not.
SUDO=""
PARENT="$(dirname "$DEST_ROOT")"
if [ ! -w "$PARENT" ] || { [ -d "$DEST_ROOT" ] && [ ! -w "$DEST_ROOT" ]; }; then SUDO="sudo"; fi

echo "Installing to: $DEST"
$SUDO mkdir -p "$DEST"
$SUDO rsync -a --delete --exclude 'WorkflowIntegration.node' --exclude '.DS_Store' "$SRC/" "$DEST/"
# Never overwrite WorkflowIntegration.node in place: a running plugin has it mapped, and
# rewriting a signed binary under it gets the process killed (Code Signature Invalid).
# Skip it when unchanged; otherwise write a new file and rename it over the old one.
if ! cmp -s "$NODE" "$DEST/WorkflowIntegration.node"; then
  $SUDO cp "$NODE" "$DEST/.WorkflowIntegration.node.new"
  $SUDO mv -f "$DEST/.WorkflowIntegration.node.new" "$DEST/WorkflowIntegration.node"
fi
echo "Done. In Resolve Studio open Workspace → Workflow Integrations → Portal."
if pgrep -x "Resolve" >/dev/null 2>&1; then
  echo "Resolve is running: close the Portal window and reopen it (or restart Resolve) to load the new version."
fi
