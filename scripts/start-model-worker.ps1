$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskScript = Join-Path $taskRoot 'scripts\kronos-worker.py'
$taskPython = Join-Path $taskRoot '.venv-model\Scripts\python.exe'
$taskOutput = Join-Path $taskRoot 'local\model-research'
if (!(Test-Path -LiteralPath $taskPython) -or !(Test-Path -LiteralPath (Join-Path $taskOutput 'artifacts.json'))) {
    throw 'MODEL_SETUP_REQUIRED'
}
if (Test-Path -LiteralPath (Join-Path $taskOutput 'STOP')) { throw 'MODEL_STOP_PRESENT' }
$taskProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($taskScript) -and $_.CommandLine -match '\bwatch(?:\s|$)' -and $_.Name -match '^python(?:w)?\.exe$'
})
if ($taskProcesses.Count) {
    @{status='already_present';pids=@($taskProcesses.ProcessId);note='Presence only; confirm status.json freshness separately.'} | ConvertTo-Json -Compress
    exit 0
}
$taskProcess = Start-Process -FilePath $taskPython -ArgumentList @('-u', ('"' + $taskScript + '"'), 'watch') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskOutput 'worker.out.log') -RedirectStandardError (Join-Path $taskOutput 'worker.err.log')
@{status='started';pid=$taskProcess.Id;executionRole='advisory';usedForOrders=$false} | ConvertTo-Json -Compress
