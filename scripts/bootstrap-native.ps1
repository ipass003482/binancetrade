$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$uvExe = Join-Path $runtimeRoot 'uv.exe'
if (-not (Test-Path -LiteralPath $uvExe)) {
    $archive = Join-Path $runtimeRoot 'uv-0.12.10.zip'
    Invoke-WebRequest -Uri 'https://github.com/astral-sh/uv/releases/download/0.12.10/uv-x86_64-pc-windows-msvc.zip' -OutFile $archive
    $expected = 'f65744f94072152b1f86ba2aace4d01f1124d9a8ecb235805039e3718c36cac2'
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'uv archive checksum mismatch' }
    Expand-Archive -LiteralPath $archive -DestinationPath $runtimeRoot
}
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtimeRoot 'python'
$env:UV_CACHE_DIR = Join-Path $projectRoot '.cache/uv'
$env:UV_PYTHON_BIN_DIR = Join-Path $runtimeRoot 'bin'
& $uvExe python install 3.12.14 --no-bin
if ($LASTEXITCODE -ne 0) { throw 'Project-local Python installation failed' }
if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    & $uvExe venv --python 3.12.14 .venv
    if ($LASTEXITCODE -ne 0) { throw 'venv creation failed' }
}
if (Test-Path -LiteralPath 'requirements.windows.lock') {
    & $uvExe pip sync --python .venv/Scripts/python.exe requirements.windows.lock
} else {
    & $uvExe pip install --python .venv/Scripts/python.exe 'freqtrade==2026.8' 'pytest>=8,<10'
}
if ($LASTEXITCODE -ne 0) { throw 'Freqtrade installation failed' }
& ./.venv/Scripts/python.exe -m freqtrade --version
