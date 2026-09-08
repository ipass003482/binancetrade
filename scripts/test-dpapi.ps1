$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$testDirectory = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../local'))) ('credential-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testDirectory | Out-Null
$testFile = Join-Path $testDirectory 'fake.dpapi.json'
$testKey = 'SYNTHETIC_DEMO_KEY_NO_ACCOUNT'
$testSecret = 'SYNTHETIC_DEMO_SECRET_NO_ACCOUNT'
$payload = @{
 version = 1
 key = (ConvertFrom-SecureString (ConvertTo-SecureString $testKey -AsPlainText -Force))
 secret = (ConvertFrom-SecureString (ConvertTo-SecureString $testSecret -AsPlainText -Force))
} | ConvertTo-Json
[IO.File]::WriteAllText($testFile, $payload, [Text.UTF8Encoding]::new($false))
try {
 $decoded = (& powershell.exe -NoProfile -File (Join-Path $PSScriptRoot 'read-demo-secret.ps1') -CredentialFile $testFile) | ConvertFrom-Json
 if ($LASTEXITCODE -ne 0 -or $decoded.key -ne $testKey -or $decoded.secret -ne $testSecret) { throw 'DPAPI roundtrip failed' }
 if ($payload.Contains($testKey) -or $payload.Contains($testSecret)) { throw 'Plaintext stored' }
 Write-Output '{"status":"passed","test":"Windows DPAPI synthetic credential roundtrip","realCredentialsUsed":false}'
} finally {
 Remove-Item -LiteralPath $testFile
 Remove-Item -LiteralPath $testDirectory
}
