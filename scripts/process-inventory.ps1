param([int]$ExcludePid)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
try {
 $items = @(Get-CimInstance Win32_Process | Where-Object {
   $_.ProcessId -ne $PID -and $_.ProcessId -ne $ExcludePid -and
   $_.CommandLine -and $_.CommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
 } | ForEach-Object { @{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; name = $_.Name } })
 ConvertTo-Json -InputObject $items -Compress
} catch { [Console]::Error.WriteLine('Process inventory unavailable'); exit 1 }
