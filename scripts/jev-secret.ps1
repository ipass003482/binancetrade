$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = $null
$clear = $null
try {
 Add-Type -AssemblyName System.Security
 $inputText = [Console]::In.ReadToEnd()
 if ($inputText.Length -gt 24000) { throw 'invalid' }
 $request = $inputText | ConvertFrom-Json
 $id = [guid]::Empty
 if (-not [guid]::TryParseExact($request.credentialId, 'D', [ref]$id)) { throw 'invalid' }
 $entropy = [Text.Encoding]::UTF8.GetBytes('binancetrade.jev.current-user.v1')
 if ($request.operation -eq 'protect') {
  $key = $request.apiKey
  if ($key -isnot [string] -or $key.Length -lt 10 -or $key.Length -gt 4096 -or $key -cnotmatch '^[\x21-\x7e]+$') { throw 'invalid' }
  $data = [Text.Encoding]::UTF8.GetBytes((@{credentialId=$request.credentialId;apiKey=$key} | ConvertTo-Json -Compress))
  $cipher = [Security.Cryptography.ProtectedData]::Protect($data,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write((@{ciphertext=[Convert]::ToBase64String($cipher)} | ConvertTo-Json -Compress))
 } elseif ($request.operation -eq 'unprotect') {
  $cipher = [Convert]::FromBase64String($request.ciphertext)
  $clear = [Security.Cryptography.ProtectedData]::Unprotect($cipher,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $value = [Text.Encoding]::UTF8.GetString($clear) | ConvertFrom-Json
  if ($value.credentialId -cne $request.credentialId -or $value.apiKey -isnot [string]) { throw 'invalid' }
  [Console]::Out.Write((@{apiKey=$value.apiKey} | ConvertTo-Json -Compress))
 } else { throw 'invalid' }
} catch {
 [Console]::Error.Write('JEV_SECRET_FAILED')
 exit 1
} finally {
 if ($null -ne $data) { [Array]::Clear($data,0,$data.Length) }
 if ($null -ne $clear) { [Array]::Clear($clear,0,$clear.Length) }
}
