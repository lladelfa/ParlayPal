<#
.SYNOPSIS
  Starts the full local ParlayPal stack: Postgres + Redis, then worker, beat and web as tabs in one Windows Terminal window.
.EXAMPLE
  .\scripts\dev.ps1          # start everything
  .\scripts\dev.ps1 -Stop    # stop containers (close the Windows Terminal window to stop the rest)
#>
param([switch]$Stop)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($Stop) {
    docker compose down
    Write-Host 'Containers stopped. Close the Windows Terminal window to stop worker/beat/web.'
    return
}

if (-not (Test-Path "$root\services\worker\.env")) {
    throw 'services/worker/.env is missing. Copy services/worker/.env.example and fill in your keys.'
}

# 1. Backing services (waits for healthchecks)
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running. Start Docker Desktop and retry.' }
docker compose up -d --wait
if ($LASTEXITCODE -ne 0) { throw 'docker compose failed to start postgres/redis.' }

# 2. Worker, beat and web as tabs in one Windows Terminal window
function Get-TabArgs($title, $dir, $cmd) {
    # Tabs inherit the environment of the already-running Windows Terminal process, which can have a
    # stale PATH (npm/uv not found). Rebuild PATH from the machine + user settings first.
    $refreshPath = '$env:Path = [Environment]::GetEnvironmentVariable(''Path'',''Machine'') + '';'' + [Environment]::GetEnvironmentVariable(''Path'',''User'')'
    $script = "$refreshPath; Set-Location '$dir'; $cmd"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    "new-tab --title `"$title`" pwsh -NoProfile -NoExit -EncodedCommand $encoded"
}

$worker = "$root\services\worker"
$celery = 'uv run celery -A parlaypal_worker.celery_app'
$tabs = @(
    (Get-TabArgs 'worker' $worker "$celery worker --pool=solo --loglevel=info"),
    (Get-TabArgs 'beat'   $worker "$celery beat --loglevel=info"),
    (Get-TabArgs 'web'    (Join-Path $root 'apps/web') 'npm run dev')
)
# ';' is wt's tab separator; Start-Process passes this string through untouched.
Start-Process wt -ArgumentList ('-w parlaypal ' + ($tabs -join ' ; '))

Write-Host ''
Write-Host 'Started. Web app: http://localhost:3000'
Write-Host 'Stop with: .\scripts\dev.ps1 -Stop'
