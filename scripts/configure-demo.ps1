$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$demoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../local/demo'))
New-Item -ItemType Directory -Path $demoRoot -Force | Out-Null
Write-Host 'Enter BINANCE DEMO keys only. These are encrypted for this Windows user.'
$demoKey = Read-Host 'Demo API Key' -AsSecureString
$demoSecret = Read-Host 'Demo Secret' -AsSecureString
$demoPayload = @{ version = 1; key = (ConvertFrom-SecureString $demoKey); secret = (ConvertFrom-SecureString $demoSecret) } | ConvertTo-Json
$demoTarget = Join-Path $demoRoot 'credentials.dpapi.json'
[IO.File]::WriteAllText($demoTarget, $demoPayload, [Text.UTF8Encoding]::new($false))
Write-Host 'Demo credentials saved encrypted. No connection or orders made.'
