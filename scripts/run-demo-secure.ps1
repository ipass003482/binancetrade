param(
 [ValidateSet('demo','demo-futures')][string]$Mode='demo',
 [ValidateSet('check','engine')][string]$Action='check'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$credentialFile = Join-Path $projectRoot ('local/'+$Mode+'/credentials.dpapi.json')
$reader = Join-Path $PSScriptRoot 'read-demo-secret.ps1'
$python = Join-Path $projectRoot '.venv/Scripts/python.exe'
$program = Join-Path $PSScriptRoot $(if ($Mode -eq 'demo-futures') {'demo-futures-engine.py'} elseif ($Action -eq 'check') {'demo-check.py'} else {'demo-engine.py'})
$arguments = @('--credentials-stdin')
if ($Mode -eq 'demo-futures' -and $Action -eq 'check') { $arguments += '--check' }

try {
 $credentialJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $reader -CredentialFile $credentialFile
 if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($credentialJson)) { throw 'Demo credential decryption failed' }
 $credentialJson | & $python $program @arguments
 if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
 $credentialJson = $null
}
