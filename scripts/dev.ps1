#!/usr/bin/env pwsh
# Local development watcher for CursorLike Sidebar.
#
# The plugin is installed as a `link:` in the DSH profile, so the app reads
# this checkout directly. `tsdown --watch` rebuilds lib/ on every source save:
#   - client-only change -> press Ctrl+R in DSH (page reload picks up lib/client*.js);
#   - host change        -> fully restart DSH (the Host half loads at boot).
#
# Usage:  pwsh -File scripts/dev.ps1
# Stop:   Ctrl+C
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Error 'node_modules is missing. Run `npm install` once, then retry.'
  exit 1
}

Write-Host ''
Write-Host 'CursorLike Sidebar — local dev watcher' -ForegroundColor Cyan
Write-Host "  root: $root"
Write-Host '  rebuilds: lib/ (host + client bundles)'
Write-Host ''
Write-Host '  client change -> press Ctrl+R in DSH'
Write-Host '  host change   -> restart DSH'
Write-Host '  typecheck     -> npm run typecheck (separate terminal)'
Write-Host '  declarations  -> npm run dev:types (separate terminal, optional)'
Write-Host ''
Write-Host 'Starting `tsdown --watch` (Ctrl+C to stop)...' -ForegroundColor DarkGray
Write-Host ''

npm run watch
