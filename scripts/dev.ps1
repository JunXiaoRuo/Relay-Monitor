[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [ValidateNotNullOrEmpty()]
  [string]$ListenAddress = '0.0.0.0',
  [ValidateRange(1, 65535)]
  [int]$WebPort = 5173,
  [ValidateRange(1, 65535)]
  [int]$ApiPort = 8080
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDirectory = Join-Path $projectRoot 'data'
$storeDirectory = Join-Path $dataDirectory 'pnpm-store'

function Get-RelayAccessAddresses {
  param([string]$BoundAddress)

  if ($BoundAddress -ne '0.0.0.0') {
    return @($BoundAddress)
  }

  $addresses = @('127.0.0.1')
  try {
    $addresses += Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object {
        $_.AddressState -eq 'Preferred' -and
        -not $_.SkipAsSource -and
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*'
      } |
      Select-Object -ExpandProperty IPAddress
  } catch {
    Write-Warning "Unable to enumerate LAN IPv4 addresses: $($_.Exception.Message)"
  }
  return @($addresses | Sort-Object -Unique)
}

Push-Location $projectRoot
try {
  $nodeCommand = Get-Command node -ErrorAction Stop
  $nodeVersion = & $nodeCommand.Source -p "process.versions.node"
  $versionParts = $nodeVersion.Split('.')
  if ($versionParts.Count -lt 2 -or [int]$versionParts[0] -ne 22 -or [int]$versionParts[1] -lt 19) {
    throw "Relay Monitor requires Node.js 22.19+ in the 22.x line; found $nodeVersion"
  }

  New-Item -ItemType Directory -Force -Path $dataDirectory, $storeDirectory | Out-Null
  if (-not $SkipInstall -and -not (Test-Path (Join-Path $projectRoot 'node_modules'))) {
    & corepack pnpm install --frozen-lockfile --store-dir $storeDirectory
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed with exit code $LASTEXITCODE" }
  }

  $env:HOST = $ListenAddress
  $env:PORT = [string]$ApiPort
  $env:RELAY_WEB_HOST = $ListenAddress
  $env:RELAY_WEB_PORT = [string]$WebPort
  $env:RELAY_API_PORT = [string]$ApiPort

  Write-Host "Relay Monitor data: $dataDirectory"
  Write-Host "Listening on $ListenAddress (Web $WebPort, API $ApiPort)"
  foreach ($address in Get-RelayAccessAddresses -BoundAddress $ListenAddress) {
    Write-Host "Web: http://${address}:$WebPort"
    Write-Host "API: http://${address}:$ApiPort"
  }
  Write-Host 'Press Ctrl+C once to stop both processes.'

  $apiCommand = 'node node_modules/tsx/dist/cli.mjs watch backend/server.ts'
  $webCommand = 'node node_modules/vite/bin/vite.js'
  & $nodeCommand.Source 'node_modules/concurrently/dist/bin/concurrently.js' '-k' '-n' 'api,web' '-c' 'blue,green' $apiCommand $webCommand
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
