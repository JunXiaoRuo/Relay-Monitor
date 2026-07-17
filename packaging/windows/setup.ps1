[CmdletBinding()]
param(
    [string]$WebOrigin,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$EnvironmentExample = Join-Path $Root '.env.example'
$EnvironmentFile = Join-Path $Root '.env'
$Launcher = Join-Path $Root 'RelayMonitor.exe'
$Node = Join-Path $Root 'runtime\node.exe'

function Assert-WebOrigin([string]$Value) {
    try {
        $Uri = [System.Uri]$Value
    } catch {
        throw "WEB_ORIGIN must be an absolute HTTP or HTTPS origin: $Value"
    }
    if (-not $Uri.IsAbsoluteUri -or $Uri.Scheme -notin @('http', 'https')) {
        throw "WEB_ORIGIN must use http or https: $Value"
    }
    if ($Uri.UserInfo -or $Uri.Query -or $Uri.Fragment -or ($Uri.AbsolutePath -ne '/')) {
        throw "WEB_ORIGIN must contain only protocol, host, and optional port: $Value"
    }
}

function Write-Utf8NoBom([string]$Path, [string]$Contents) {
    $Encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Contents, $Encoding)
}

function Set-EnvironmentValue([string]$Contents, [string]$Name, [string]$Value) {
    $Pattern = '(?m)^' + [regex]::Escape($Name) + '=.*$'
    if ([regex]::IsMatch($Contents, $Pattern)) {
        return [regex]::Replace($Contents, $Pattern, "$Name=$Value")
    }
    return $Contents.TrimEnd("`r", "`n") + "`r`n$Name=$Value`r`n"
}

function Protect-NewMasterKey([string]$Path) {
    $CurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $Arguments = @(
        $Path,
        '/inheritance:r',
        '/grant:r',
        "*$($CurrentSid):F",
        '*S-1-5-18:F',
        '*S-1-5-32-544:F',
        '*S-1-5-20:R'
    )
    & icacls.exe @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not restrict master key ACL: $Path"
    }
}

if (-not (Test-Path -LiteralPath $EnvironmentExample -PathType Leaf)) {
    throw "Missing $EnvironmentExample"
}
if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) {
    throw "Missing $Launcher"
}
if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) {
    throw "Missing $Node"
}

$CreatingEnvironment = -not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)
$Contents = if ($CreatingEnvironment) {
    [System.IO.File]::ReadAllText($EnvironmentExample)
} else {
    [System.IO.File]::ReadAllText($EnvironmentFile)
}

if ($WebOrigin) {
    Assert-WebOrigin $WebOrigin
    $Contents = Set-EnvironmentValue $Contents 'WEB_ORIGIN' $WebOrigin
}
if ($CreatingEnvironment -or $WebOrigin) {
    Write-Utf8NoBom $EnvironmentFile $Contents
    Write-Host "Configuration written to $EnvironmentFile"
} else {
    Write-Host "Keeping existing configuration at $EnvironmentFile"
}

$KeyMatch = [regex]::Match($Contents, '(?m)^MASTER_KEY_FILE=(.+)$')
if (-not $KeyMatch.Success) {
    throw 'MASTER_KEY_FILE is missing from .env'
}
$ConfiguredKeyPath = $KeyMatch.Groups[1].Value.Trim().Trim('"').Trim("'")
$KeyPath = if ([System.IO.Path]::IsPathRooted($ConfiguredKeyPath)) {
    [System.IO.Path]::GetFullPath($ConfiguredKeyPath)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $Root $ConfiguredKeyPath))
}
$KeyDirectory = Split-Path -Parent $KeyPath
[System.IO.Directory]::CreateDirectory($KeyDirectory) | Out-Null

$CreatedKey = -not (Test-Path -LiteralPath $KeyPath -PathType Leaf)
if ($CreatedKey) {
    $Key = New-Object byte[] 32
    $Generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $Generator.GetBytes($Key)
        $Stream = New-Object System.IO.FileStream(
            $KeyPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $Stream.Write($Key, 0, $Key.Length)
        } finally {
            $Stream.Dispose()
        }
    } finally {
        [Array]::Clear($Key, 0, $Key.Length)
        $Generator.Dispose()
    }
    Protect-NewMasterKey $KeyPath
}

$ValidatorScript = Join-Path ([System.IO.Path]::GetTempPath()) ("relay-monitor-key-check-" + [guid]::NewGuid().ToString('N') + '.mjs')
try {
    Write-Utf8NoBom $ValidatorScript @'
import { pathToFileURL } from 'node:url';
try {
  const modulePath = process.argv[2];
  const keyPath = process.argv[3];
  const { loadMasterKeyRing } = await import(pathToFileURL(modulePath).href);
  const keyring = loadMasterKeyRing({ filePath: keyPath, environment: 'production' }, 1);
  for (const key of keyring.keys.values()) key.fill(0);
  keyring.keys.clear();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Master key validation failed');
  process.exitCode = 1;
}
'@
    & $Node $ValidatorScript (Join-Path $Root 'dist\server\backend\core\vault.js') $KeyPath
    if ($LASTEXITCODE -ne 0) {
        throw "Master key validation failed with exit code $LASTEXITCODE"
    }
} finally {
    if (Test-Path -LiteralPath $ValidatorScript) {
        Remove-Item -LiteralPath $ValidatorScript -Force
    }
}
if ($CreatedKey) {
    Write-Host "A new master key was created and validated at $KeyPath"
} else {
    Write-Host "Keeping the validated master key at $KeyPath"
}

& $Launcher migrate
if ($LASTEXITCODE -ne 0) {
    throw "Database migration failed with exit code $LASTEXITCODE"
}

Write-Host 'Setup complete.'
Write-Host 'Create the first administrator with:'
Write-Host '  .\RelayMonitor.exe admin create --username admin --display-name "Administrator"'
Write-Host 'Start Relay Monitor with:'
Write-Host '  .\RelayMonitor.exe start'
