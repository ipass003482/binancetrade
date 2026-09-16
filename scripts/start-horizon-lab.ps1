$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskScript = Join-Path $taskRoot 'scripts\kronos-horizon-lab.py'
$taskPython = Join-Path $taskRoot '.venv-model\Scripts\python.exe'
$taskOutput = Join-Path $taskRoot 'local\horizon-lab'
if (!(Test-Path -LiteralPath $taskPython) -or !(Test-Path -LiteralPath $taskScript) -or
    !(Test-Path -LiteralPath (Join-Path $taskRoot 'local\model-research\artifacts.json'))) {
    throw 'HORIZON_LAB_SETUP_REQUIRED'
}
if ((Test-Path -LiteralPath (Join-Path $taskOutput 'STOP')) -or
    (Test-Path -LiteralPath (Join-Path $taskRoot 'local\model-research\STOP'))) {
    throw 'HORIZON_LAB_STOP_PRESENT'
}
$taskProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($taskScript) -and
    $_.CommandLine -match '\bwatch(?:\s|$)' -and $_.Name -match '^python(?:w)?\.exe$'
})
if ($taskProcesses.Count) {
    @{status='already_present';pids=@($taskProcesses.ProcessId);note='Presence only; verify status.json freshness separately.'} | ConvertTo-Json -Compress
    exit 0
}
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskStamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$taskProcess = Start-Process -FilePath $taskPython -ArgumentList @('-u', ('"' + $taskScript + '"'), 'watch') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskOutput ('worker.' + $taskStamp + '.out.log')) -RedirectStandardError (Join-Path $taskOutput ('worker.' + $taskStamp + '.err.log'))
@{status='started';pid=$taskProcess.Id;executionRole='prospective_forecast_comparison';usedForOrders=$false;automaticPromotion=$false} | ConvertTo-Json -Compress
