# 用法（在專案根目錄的 PowerShell）： . .\dev-env.ps1
# 只影響目前這個終端機視窗，不修改系統或使用者的環境變數。
$root = $PSScriptRoot
$tools = Join-Path $root '.tools'

# --- Node.js 免安裝版 ---
$node = Get-ChildItem $tools -Directory -Filter 'node-v*-win-x64' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($node) { $env:PATH = "$($node.FullName);$env:PATH" } else { Write-Warning '找不到 .tools\node-v*-win-x64' }

# --- Rust：優先使用 .tools 內的安裝，否則使用預設的 ~/.cargo ---
$cargoHome = Join-Path $tools 'cargo'
if (Test-Path $cargoHome) {
    $env:CARGO_HOME = $cargoHome
    $env:RUSTUP_HOME = Join-Path $tools 'rustup'
    $env:PATH = "$cargoHome\bin;$env:PATH"
} else {
    $env:PATH = "$HOME\.cargo\bin;$env:PATH"
}

# --- MSVC（可攜式，位於 .tools\BuildTools）+ Windows SDK ---
# Windows SDK 優先使用 .tools\BuildTools\Windows Kits\10，找不到則使用系統安裝的
# C:\Program Files (x86)\Windows Kits\10。
function Get-LatestChild([string]$path) {
    Get-ChildItem $path -Directory -ErrorAction SilentlyContinue | Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending | Select-Object -First 1
}

$vc = Get-LatestChild (Join-Path $tools 'BuildTools\VC\Tools\MSVC')
$sdkCandidates = @(
    (Join-Path $tools 'BuildTools\Windows Kits\10'),
    'C:\Program Files (x86)\Windows Kits\10'
)
$sdkDir = $sdkCandidates | Where-Object { Test-Path (Join-Path $_ 'Lib') } | Select-Object -First 1
$sdk = if ($sdkDir) { Get-LatestChild (Join-Path $sdkDir 'Lib') }

if (-not $vc) {
    Write-Warning '找不到 MSVC（.tools\BuildTools\VC\Tools\MSVC）'
} elseif (-not $sdk) {
    Write-Warning '找不到 Windows SDK（.tools\BuildTools\Windows Kits\10 或系統的 Windows Kits\10）'
} else {
    $ver = $sdk.Name
    $arch = 'x64'
    $env:VCToolsInstallDir = $vc.FullName
    $env:WindowsSDKDir = $sdkDir
    $env:WindowsSDKVersion = $ver
    $env:INCLUDE = @(
        "$($vc.FullName)\include",
        "$sdkDir\Include\$ver\ucrt", "$sdkDir\Include\$ver\shared", "$sdkDir\Include\$ver\um",
        "$sdkDir\Include\$ver\winrt", "$sdkDir\Include\$ver\cppwinrt"
    ) -join ';'
    $env:LIB = @(
        "$($vc.FullName)\lib\$arch",
        "$sdkDir\Lib\$ver\ucrt\$arch", "$sdkDir\Lib\$ver\um\$arch"
    ) -join ';'
    $env:PATH = "$($vc.FullName)\bin\Hostx64\$arch;$sdkDir\bin\$ver\$arch;$env:PATH"
    Write-Host "MSVC: $($vc.Name)   Windows SDK: $ver ($sdkDir)"
}

Write-Host "node : $((Get-Command node -ErrorAction SilentlyContinue).Source)"
Write-Host "cargo: $((Get-Command cargo -ErrorAction SilentlyContinue).Source)"
Write-Host "link : $((Get-Command link -ErrorAction SilentlyContinue).Source)"
Write-Host "rc   : $((Get-Command rc -ErrorAction SilentlyContinue).Source)"
