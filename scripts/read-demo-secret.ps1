param(
 [Parameter(Mandatory=$true)][string]$CredentialFile,
 [switch]$ProbeOnly
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
try {
 $demoStored = Get-Content -LiteralPath $CredentialFile -Raw | ConvertFrom-Json
 $demoResult = @{}
 foreach ($demoField in @('key','secret')) {
  $demoSecure = ConvertTo-SecureString $demoStored.$demoField
  $demoPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($demoSecure)
  try { $demoResult[$demoField] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($demoPointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($demoPointer) }
 }
 if ($ProbeOnly) {
  @{ status = 'passed'; keyPresent = ($demoResult.key.Length -ge 16); secretPresent = ($demoResult.secret.Length -ge 16); credentialsExposed = $false } | ConvertTo-Json -Compress
 } else {
  $demoResult | ConvertTo-Json -Compress
 }
} catch { [Console]::Error.WriteLine('Demo credential decryption failed'); exit 1 }
