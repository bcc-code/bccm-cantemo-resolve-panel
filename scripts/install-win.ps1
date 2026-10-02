# Installs Portal for Resolve into DaVinci Resolve Studio's Workflow Integration Plugins folder (Windows).
# Run from an elevated PowerShell:  powershell -ExecutionPolicy Bypass -File scripts\install-win.ps1
$ErrorActionPreference = 'Stop'

$PluginId = 'media.bcc.portal'
$Src = Join-Path $PSScriptRoot '..\plugin' | Resolve-Path
$DestRoot = Join-Path $env:PROGRAMDATA 'Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins'
$Dest = Join-Path $DestRoot $PluginId

$Candidates = @(
  (Join-Path $env:PROGRAMDATA 'Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node'),
  (Join-Path $env:ProgramFiles 'Blackmagic Design\DaVinci Resolve\Workflow Integration\WorkflowIntegration.node')
)
$Node = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Node) {
  Write-Error ("WorkflowIntegration.node not found. Is DaVinci Resolve Studio installed? Looked in:`n  " + ($Candidates -join "`n  "))
}

if (Get-Process -Name 'Resolve' -ErrorAction SilentlyContinue) {
  Write-Warning 'Resolve is running. Restart it after installing to load the plugin.'
}

Write-Host "Installing to: $Dest"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Path (Join-Path $Src '*') -Destination $Dest -Recurse -Force
# WorkflowIntegration.node is locked while the plugin runs; only replace it when it changed.
$Target = Join-Path $Dest 'WorkflowIntegration.node'
if (-not (Test-Path $Target) -or (Get-FileHash $Node).Hash -ne (Get-FileHash $Target).Hash) {
  Copy-Item -Path $Node -Destination $Target -Force
}
Write-Host 'Done. In Resolve Studio open Workspace -> Workflow Integrations -> Portal.'
