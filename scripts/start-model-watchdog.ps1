$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskScript = Join-Path $taskRoot 'src\model-watchdog.mjs'
$taskNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$taskOutput = Join-Path $taskRoot 'local\model-watchdog'
if (!(Test-Path -LiteralPath $taskNode -PathType Leaf) -or !(Test-Path -LiteralPath $taskScript -PathType Leaf)) { throw 'WATCHDOG_RUNTIME_MISSING' }
if ((Test-Path -LiteralPath (Join-Path $taskOutput 'STOP')) -or (Test-Path -LiteralPath (Join-Path $taskRoot 'local\model-research\STOP'))) { throw 'WATCHDOG_STOP_PRESENT' }
if ((Test-Path -LiteralPath (Join-Path $taskRoot 'local\demo\STOP')) -and (Test-Path -LiteralPath (Join-Path $taskRoot 'local\demo-futures\STOP'))) { throw 'WATCHDOG_BOTH_MODES_STOPPED' }
$taskPattern = '^(?:"' + [regex]::Escape($taskNode) + '"|' + [regex]::Escape($taskNode) + ')\s+(?:"' + [regex]::Escape($taskScript) + '"|' + [regex]::Escape($taskScript) + ')\s+watch\s*$'
$taskExisting = @()
foreach ($taskCandidate in @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' })) {
    if (!$taskCandidate.CommandLine -and !$taskCandidate.ExecutablePath) { throw 'WATCHDOG_PROCESS_IDENTITY_UNAVAILABLE' }
    if ($taskCandidate.CommandLine -and $taskCandidate.CommandLine.IndexOf($taskScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        if ($taskCandidate.ExecutablePath -ne $taskNode -or $taskCandidate.CommandLine -notmatch $taskPattern) { throw 'WATCHDOG_PROCESS_IDENTITY_AMBIGUOUS' }
        $taskExisting += $taskCandidate
    }
}
if ($taskExisting.Count -gt 1) { throw 'WATCHDOG_MULTIPLE_PROCESSES' }
if ($taskExisting.Count -eq 1) {
    @{status='already_present';pids=@($taskExisting.ProcessId);note='Confirm watchdog status and model source freshness separately.'} | ConvertTo-Json -Compress
    exit 0
}
# A crash leaves this lock intentionally. Do not delete a PID lock automatically:
# inspect its owner, exact process command and creation time, then archive it under
# local/model-watchdog before a human-controlled recovery. The durable budget stays.
if (Test-Path -LiteralPath (Join-Path $taskOutput 'worker.lock')) { throw 'WATCHDOG_STALE_LOCK_REQUIRES_MANUAL_OWNER_AND_PROCESS_INSPECTION; preserve budget.json and archive only the verified stale watchdog lock.' }
$taskCheck = & $taskNode $taskScript check
if ($LASTEXITCODE -ne 0) { throw 'WATCHDOG_PREFLIGHT_FAILED' }
$taskCheckResult = ($taskCheck -join "`n") | ConvertFrom-Json
if ($taskCheckResult.status -eq 'paused') { throw 'WATCHDOG_PREFLIGHT_PAUSED' }
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskSuffix = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @(('"' + $taskScript + '"'), 'watch') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskOutput ('worker-' + $taskSuffix + '.out.log')) -RedirectStandardError (Join-Path $taskOutput ('worker-' + $taskSuffix + '.err.log'))
@{status='started';pid=$taskProcess.Id;orderAuthority='none';killsProcesses=$false;note='Singleton is acquired by the child; verify local/model-watchdog/status.json.'} | ConvertTo-Json -Compress
