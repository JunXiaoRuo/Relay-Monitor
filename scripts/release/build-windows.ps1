[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$OutputDirectory = 'artifacts',
    [string]$NodeVersion = '22.23.1',
    [switch]$SkipApplicationBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') {
    throw "Version contains unsupported characters: $Version"
}
if ($NodeVersion -notmatch '^22\.[0-9]+\.[0-9]+$') {
    throw "NodeVersion must be a Node.js 22 release: $NodeVersion"
}
$BuildNodeVersion = (& node -p 'process.versions.node').Trim()
if ($LASTEXITCODE -ne 0 -or $BuildNodeVersion -notmatch '^22\.([0-9]+)\.[0-9]+$' -or [int]$Matches[1] -lt 19) {
    throw "Release builds require Node.js 22.19 or newer in the 22.x line; found $BuildNodeVersion"
}

$RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$OutputPath = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
    [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot $OutputDirectory))
}
[System.IO.Directory]::CreateDirectory($OutputPath) | Out-Null

$PackageName = "relay-monitor-$Version-windows-x64"
$ArtifactPath = Join-Path $OutputPath "$PackageName.zip"
$TemporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("relay-monitor-release-" + [guid]::NewGuid().ToString('N'))
$Stage = Join-Path $TemporaryRoot $PackageName

function Invoke-External([scriptblock]$Command, [string]$Description) {
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

function Copy-Required([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Source)) {
        throw "Required release input is missing: $Source"
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

try {
    [System.IO.Directory]::CreateDirectory($Stage) | Out-Null

    if (-not $SkipApplicationBuild) {
        Push-Location $RepositoryRoot
        try {
            Invoke-External { corepack pnpm build } 'Application build'
        } finally {
            Pop-Location
        }
    }

    Copy-Required (Join-Path $RepositoryRoot 'dist') (Join-Path $Stage 'dist')
    Copy-Required (Join-Path $RepositoryRoot 'package.json') (Join-Path $Stage 'package.json')
    Copy-Required (Join-Path $RepositoryRoot 'pnpm-lock.yaml') (Join-Path $Stage 'pnpm-lock.yaml')
    Copy-Required (Join-Path $RepositoryRoot 'pnpm-workspace.yaml') (Join-Path $Stage 'pnpm-workspace.yaml')
    Copy-Required (Join-Path $RepositoryRoot 'packaging\portable.env.example') (Join-Path $Stage '.env.example')
    Copy-Required (Join-Path $RepositoryRoot 'packaging\README.md') (Join-Path $Stage 'README.md')
    Copy-Required (Join-Path $RepositoryRoot 'packaging\windows\setup.ps1') (Join-Path $Stage 'setup.ps1')
    [System.IO.Directory]::CreateDirectory((Join-Path $Stage 'service')) | Out-Null
    Copy-Required `
        (Join-Path $RepositoryRoot 'packaging\windows\relay-monitor-service.xml.example') `
        (Join-Path $Stage 'service\relay-monitor-service.xml.example')
    if (Test-Path -LiteralPath (Join-Path $RepositoryRoot 'LICENSE') -PathType Leaf) {
        Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'LICENSE') -Destination (Join-Path $Stage 'LICENSE')
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $Stage 'VERSION'),
        "$Version`n",
        (New-Object System.Text.UTF8Encoding($false))
    )

    Get-ChildItem -LiteralPath (Join-Path $Stage 'dist') -Recurse -File -Filter '*.map' |
        Remove-Item -Force

    Push-Location $Stage
    try {
        Invoke-External {
            corepack pnpm install --prod --frozen-lockfile `
                --config.node-linker=hoisted --config.package-import-method=copy
        } 'Production dependency installation'
    } finally {
        Pop-Location
    }
    Get-ChildItem -LiteralPath $Stage -Recurse -File -Filter '*.map' |
        Remove-Item -Force

    $RuntimeDirectory = Join-Path $Stage 'runtime'
    [System.IO.Directory]::CreateDirectory($RuntimeDirectory) | Out-Null
    $RuntimeArchiveName = "node-v$NodeVersion-win-x64.zip"
    $RuntimeArchive = Join-Path $TemporaryRoot $RuntimeArchiveName
    $ChecksumsFile = Join-Path $TemporaryRoot 'SHASUMS256.txt'
    Invoke-WebRequest -UseBasicParsing `
        -Uri "https://nodejs.org/dist/v$NodeVersion/$RuntimeArchiveName" `
        -OutFile $RuntimeArchive
    Invoke-WebRequest -UseBasicParsing `
        -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" `
        -OutFile $ChecksumsFile
    $ChecksumContents = [System.IO.File]::ReadAllText($ChecksumsFile)
    $ChecksumPattern = '(?m)^([0-9a-f]{64})\s+\*?' + [regex]::Escape($RuntimeArchiveName) + '\r?$'
    $ChecksumMatch = [regex]::Match($ChecksumContents, $ChecksumPattern)
    if (-not $ChecksumMatch.Success) {
        throw "Official checksum for $RuntimeArchiveName was not found"
    }
    $ActualChecksum = (Get-FileHash -LiteralPath $RuntimeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualChecksum -ne $ChecksumMatch.Groups[1].Value.ToLowerInvariant()) {
        throw "Node.js runtime checksum mismatch for $RuntimeArchiveName"
    }
    $RuntimeExtract = Join-Path $TemporaryRoot 'runtime-extract'
    Expand-Archive -LiteralPath $RuntimeArchive -DestinationPath $RuntimeExtract
    $ExtractedRuntime = Join-Path $RuntimeExtract "node-v$NodeVersion-win-x64"
    Copy-Required (Join-Path $ExtractedRuntime 'node.exe') (Join-Path $RuntimeDirectory 'node.exe')
    Copy-Required (Join-Path $ExtractedRuntime 'LICENSE') (Join-Path $RuntimeDirectory 'LICENSE.node.txt')
    [System.IO.File]::WriteAllText(
        (Join-Path $RuntimeDirectory 'VERSION'),
        "$NodeVersion`n",
        (New-Object System.Text.UTF8Encoding($false))
    )

    $LauncherDirectory = Join-Path $RepositoryRoot 'packaging\launcher'
    Push-Location $LauncherDirectory
    $PreviousCgo = $env:CGO_ENABLED
    try {
        $env:CGO_ENABLED = '0'
        Invoke-External {
            go build -trimpath -ldflags "-s -w -X main.version=$Version" `
                -o (Join-Path $Stage 'RelayMonitor.exe') .
        } 'Windows launcher build'
    } finally {
        $env:CGO_ENABLED = $PreviousCgo
        Pop-Location
    }

    $ForbiddenEnvironment = Join-Path $Stage '.env'
    if (Test-Path -LiteralPath $ForbiddenEnvironment) {
        throw 'Release staging unexpectedly contains .env'
    }
    if (Test-Path -LiteralPath (Join-Path $Stage 'data')) {
        throw 'Release staging unexpectedly contains a data directory'
    }
    if (Get-ChildItem -LiteralPath $Stage -Recurse -File -Filter '*.map' | Select-Object -First 1) {
        throw 'Release staging unexpectedly contains source maps'
    }

    if (Test-Path -LiteralPath $ArtifactPath) {
        Remove-Item -LiteralPath $ArtifactPath -Force
    }
    Invoke-External {
        tar.exe -a -cf $ArtifactPath -C $TemporaryRoot $PackageName
    } 'Windows archive creation'
    Write-Host "Created $ArtifactPath"
} finally {
    if (Test-Path -LiteralPath $TemporaryRoot) {
        Remove-Item -LiteralPath $TemporaryRoot -Recurse -Force
    }
}
