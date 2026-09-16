param([int]$ExcludePid)
$ErrorActionPreference = 'Stop'
$tradeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tradeRows = @(Get-CimInstance Win32_Process | ForEach-Object {
 if ($_.ProcessId -eq $PID -or $_.ProcessId -eq $ExcludePid) { return }
 if (-not $_.CommandLine) {
  if ($_.Name -match '^(pythonw?|node)(?:[0-9.]*)?\.exe$') { @{pid=$_.ProcessId; parentPid=$_.ParentProcessId; inventoryUnknown=$true; projectVerified=$false; mode='unknown'; role='unknown'} }
  return
 }
 $tradeCommand = $_.CommandLine
 $tradeInRoot = $tradeCommand.IndexOf($tradeRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
 $tradeMode = $null; $tradeRole = $null
 if ($tradeCommand -match '[\\/]demo-futures-engine\.py') { $tradeMode = 'demo-futures'; $tradeRole = 'engine' }
 elseif ($tradeCommand -match '[\\/]demo-engine\.py') { $tradeMode = 'demo'; $tradeRole = 'engine' }
 elseif ($tradeCommand -match 'cli\.mjs["\s]+(engine|watch)\s+--mode\s+(demo-futures|demo)(?:\s|$)') { $tradeRole = $Matches[1]; $tradeMode = $Matches[2] }
 if ($tradeMode) { @{pid=$_.ProcessId; parentPid=$_.ParentProcessId; mode=$tradeMode; role=$tradeRole; projectVerified=$tradeInRoot} }
})
ConvertTo-Json -InputObject $tradeRows -Compress
