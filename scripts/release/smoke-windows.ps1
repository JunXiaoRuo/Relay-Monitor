[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,
    [string]$ExpectedNodeVersion = '22.23.1'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ResolvedArchive = (Resolve-Path -LiteralPath $ArchivePath).Path
$TemporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("relay-monitor-smoke-" + [guid]::NewGuid().ToString('N'))
$ExtractDirectory = Join-Path $TemporaryRoot 'extract'
$ServerProcess = $null
$StandardOutput = Join-Path $TemporaryRoot 'server.stdout.log'
$StandardError = Join-Path $TemporaryRoot 'server.stderr.log'

function Invoke-External([scriptblock]$Command, [string]$Description) {
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

function Require-File([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required packaged file is missing: $Path"
    }
}

try {
    [System.IO.Directory]::CreateDirectory($ExtractDirectory) | Out-Null
    $ArchiveEntries = @(& tar.exe -tf $ResolvedArchive)
    if ($LASTEXITCODE -ne 0) {
        throw "Cannot list archive $ResolvedArchive"
    }
    foreach ($Entry in $ArchiveEntries) {
        $Normalized = $Entry.Replace('\', '/')
        if ($Normalized -match '^[^/]+/\.env$' -or
            $Normalized -match '^[^/]+/data(/|$)' -or
            $Normalized -match '\.map$') {
            throw "Forbidden release content: $Entry"
        }
    }
    Invoke-External { tar.exe -xf $ResolvedArchive -C $ExtractDirectory } 'Archive extraction'

    $Roots = @(Get-ChildItem -LiteralPath $ExtractDirectory -Directory)
    if ($Roots.Count -ne 1) {
        throw "Expected exactly one package directory, found $($Roots.Count)"
    }
    $Root = $Roots[0].FullName
    $Launcher = Join-Path $Root 'RelayMonitor.exe'
    $Node = Join-Path $Root 'runtime\node.exe'
    Require-File $Launcher
    Require-File $Node
    Require-File (Join-Path $Root 'runtime\LICENSE.node.txt')
    Require-File (Join-Path $Root 'LICENSE')
    Require-File (Join-Path $Root 'dist\web\index.html')
    Require-File (Join-Path $Root 'dist\server\backend\server.js')
    Require-File (Join-Path $Root 'dist\server\backend\db\migrations\meta\_journal.json')
    Require-File (Join-Path $Root '.env.example')
    Require-File (Join-Path $Root 'README.md')
    Require-File (Join-Path $Root 'VERSION')
    Require-File (Join-Path $Root 'service\relay-monitor-service.xml.example')
    Require-File (Join-Path $Root 'setup.ps1')

    $ActualVersion = (& $Launcher version).Trim()
    if ($LASTEXITCODE -ne 0 -or $ActualVersion -ne $ExpectedVersion) {
        throw "Launcher version mismatch: expected $ExpectedVersion, found $ActualVersion"
    }
    $ActualNodeVersion = (& $Node --version).Trim().TrimStart('v')
    if ($LASTEXITCODE -ne 0 -or $ActualNodeVersion -ne $ExpectedNodeVersion) {
        throw "Node.js version mismatch: expected $ExpectedNodeVersion, found $ActualNodeVersion"
    }

    $NativeSmokeScript = Join-Path $Root '.release-native-smoke.cjs'
    [System.IO.File]::WriteAllText($NativeSmokeScript, @'
const argon2 = require('argon2');
const Database = require('better-sqlite3');
(async () => {
  const hash = await argon2.hash('release-smoke-password');
  if (!await argon2.verify(hash, 'release-smoke-password')) throw new Error('argon2 verification failed');
  const db = new Database(':memory:');
  db.exec('create table smoke(value integer); insert into smoke values (1)');
  if (db.prepare('select value from smoke').get().value !== 1) throw new Error('better-sqlite3 query failed');
  db.close();
})().catch((error) => { console.error(error); process.exit(1); });
'@, (New-Object System.Text.UTF8Encoding($false)))
    $IntegrityScript = Join-Path $Root '.release-sqlite-integrity.cjs'
    [System.IO.File]::WriteAllText($IntegrityScript, @'
const Database = require('better-sqlite3');
const db = new Database('./data/monitor.db', { readonly: true });
const quick = db.pragma('quick_check');
if (quick.some((row) => Object.values(row)[0] !== 'ok')) throw new Error('SQLite quick_check failed');
if (db.pragma('foreign_key_check').length) throw new Error('SQLite foreign_key_check failed');
db.close();
'@, (New-Object System.Text.UTF8Encoding($false)))

    Push-Location $Root
    try {
        Invoke-External {
            & $Node $NativeSmokeScript
        } 'Native module smoke test'

        & (Join-Path $Root 'setup.ps1') -NonInteractive

        $Listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
        $Listener.Start()
        $Port = ([System.Net.IPEndPoint]$Listener.LocalEndpoint).Port
        $Listener.Stop()
        $EnvironmentFile = Join-Path $Root '.env'
        $EnvironmentContents = [System.IO.File]::ReadAllText($EnvironmentFile)
        $EnvironmentContents = [regex]::Replace($EnvironmentContents, '(?m)^HOST=.*$', 'HOST=127.0.0.1')
        $EnvironmentContents = [regex]::Replace($EnvironmentContents, '(?m)^PORT=.*$', "PORT=$Port")
        [System.IO.File]::WriteAllText(
            $EnvironmentFile,
            $EnvironmentContents,
            (New-Object System.Text.UTF8Encoding($false))
        )

        $ServerProcess = Start-Process -FilePath $Launcher -ArgumentList 'start' `
            -WorkingDirectory $Root -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $StandardOutput -RedirectStandardError $StandardError
        $Ready = $false
        $Deadline = [DateTime]::UtcNow.AddSeconds(60)
        while ([DateTime]::UtcNow -lt $Deadline) {
            if ($ServerProcess.HasExited) {
                break
            }
            try {
                $Response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/readyz" -UseBasicParsing -TimeoutSec 2
                if ($Response.StatusCode -eq 200) {
                    $Ready = $true
                    break
                }
            } catch {
                Start-Sleep -Milliseconds 500
            }
        }
        if (-not $Ready) {
            $OutputText = if (Test-Path -LiteralPath $StandardOutput) { [System.IO.File]::ReadAllText($StandardOutput) } else { '' }
            $ErrorText = if (Test-Path -LiteralPath $StandardError) { [System.IO.File]::ReadAllText($StandardError) } else { '' }
            throw "Relay Monitor did not become ready.`nSTDOUT:`n$OutputText`nSTDERR:`n$ErrorText"
        }
        $RootResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5
        if ($RootResponse.StatusCode -ne 200 -or $RootResponse.Content -notmatch '<!doctype html') {
            throw 'Packaged Web application did not return its index page'
        }

        & taskkill.exe /PID $ServerProcess.Id /T /F 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not stop the packaged process tree (taskkill exit $LASTEXITCODE)"
        }
        if (-not $ServerProcess.WaitForExit(15000)) {
            throw 'Packaged launcher did not exit after its process tree was stopped'
        }
        $ServerProcess.Dispose()
        $ServerProcess = $null

        Invoke-External {
            & $Node $IntegrityScript
        } 'SQLite integrity test'
    } finally {
        Pop-Location
    }

    Write-Host "Windows release smoke test passed: $ResolvedArchive"
} finally {
    if ($null -ne $ServerProcess) {
        $ServerProcess.Refresh()
        if (-not $ServerProcess.HasExited) {
            & taskkill.exe /PID $ServerProcess.Id /T /F 2>$null | Out-Null
        }
        $ServerProcess.Dispose()
    }
    if (Test-Path -LiteralPath $TemporaryRoot) {
        Remove-Item -LiteralPath $TemporaryRoot -Recurse -Force
    }
}
