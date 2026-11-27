# 將打包好的 exe / 安裝檔上傳為 Gitea / Forgejo 的 Release（可重複執行，會覆蓋同 tag 的說明與附件）。
#
# 用法（專案根目錄，PowerShell）：
#   $env:GIT_TOKEN = "你的存取權杖"      # 只存在這個終端機視窗，不會寫入檔案
#   .\scripts\publish-release.ps1                # 使用最新的 git tag
#   .\scripts\publish-release.ps1 -Tag v0.2.1    # 指定 tag
#
# 權杖需要「repository 寫入」權限（Gitea：設定 → 應用程式 → 產生新權杖）。

param([string]$Tag)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

# 繁中 Windows 的主控台預設是 cp950，會把 git 輸出的 UTF-8 中文解成亂碼，因此一律改用 UTF-8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

if (-not $env:GIT_TOKEN) { throw '請先設定 $env:GIT_TOKEN（存取權杖）' }

# 由 origin 網址解析主機、擁有者、專案名稱
$remote = git remote get-url origin
if ($remote -notmatch '^https?://([^/]+)/([^/]+)/(.+?)(\.git)?$') { throw "無法解析 origin：$remote" }
$hostName, $owner, $repo = $Matches[1], $Matches[2], $Matches[3]
$api = "https://$hostName/api/v1/repos/$owner/$repo"

if (-not $Tag) { $Tag = git describe --tags --abbrev=0 }
if (-not (git tag -l $Tag)) { throw "找不到 tag：$Tag" }
if (-not (git ls-remote --tags origin $Tag)) { throw "tag $Tag 尚未推送到 origin，請先 git push origin $Tag" }

# 收集要上傳的檔案：只收與 tag 版本號相符的，避免誤傳舊版本的打包檔
# 每個項目為 @{ Path = 本機路徑; Name = 上傳後的檔名 }
$ver = $Tag.TrimStart('v')
$files = @()
# 主程式檔名由 tauri.conf.json 的 mainBinaryName 決定（Label Printer.exe）；免安裝版與安裝檔統一以「Label Printer」命名
# 測試版（標籤帶 -）是用 fast 設定檔打包的（scripts/build.mjs）
$out = if ($ver -match '-') { 'src-tauri\target\fast' } else { 'src-tauri\target\release' }
$exe = "$out\Label Printer.exe"
if (Test-Path -LiteralPath $exe) {
    $files += @{ Path = (Resolve-Path -LiteralPath $exe).Path; Name = "Label Printer_${ver}_x64-portable.exe" }
}
$setup = Get-ChildItem "$out\bundle\nsis\*_${ver}_x64-setup.exe" -ErrorAction SilentlyContinue
foreach ($s in $setup) { $files += @{ Path = $s.FullName; Name = $s.Name } }
if (-not $setup) { throw "找不到版本 $ver 的安裝檔，請確認已用該版本執行 npm run dist" }

$auth = @('-H', "Authorization: token $($env:GIT_TOKEN)")
# git 會回傳多行陣列，必須合併成單一字串，否則 Gitea 會回 422
$notes = (git tag -l $Tag --format='%(contents)') -join "`n"

function Get-Brief([string]$text) {
    $t = ($text -replace '\s+', ' ').Trim()
    if ($t.Length -gt 300) { $t.Substring(0, 300) + '…' } else { $t }
}

# 以 UTF-8（無 BOM）暫存檔送出 JSON，避免經由管線被轉成系統編碼
function Invoke-Api([string]$Method, [string]$Url, $Body = $null) {
    $args2 = @('-sS') + $auth + @('-X', $Method, $Url, '-w', "`n%{http_code}")
    $tmp = $null
    if ($null -ne $Body) {
        $tmp = New-TemporaryFile
        [IO.File]::WriteAllText($tmp.FullName, ($Body | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
        $args2 += @('-H', 'Content-Type: application/json; charset=utf-8', '--data-binary', "@$($tmp.FullName)")
    }
    try { $out = (curl.exe @args2) -join "`n" } finally { if ($tmp) { Remove-Item $tmp -Force } }
    $lines = $out -split "`n"
    [pscustomobject]@{ Code = $lines[-1].Trim(); Json = ($lines[0..($lines.Count - 2)] -join "`n") }
}

# 建立 Release；已存在（409）則更新說明並清掉舊附件
# 版本號帶預發行後綴（例如 v1.0.0-a）的標成「預發行」，不會被當成最新正式版
$pre = $Tag -match '-'
$r = Invoke-Api POST "$api/releases" @{ tag_name = $Tag; name = $Tag; body = $notes; prerelease = $pre }
if ($r.Code -eq '201') {
    $release = $r.Json | ConvertFrom-Json
} elseif ($r.Code -eq '409') {
    $got = Invoke-Api GET "$api/releases/tags/$Tag"
    if ($got.Code -ne '200') { throw "讀取既有 Release 失敗（HTTP $($got.Code)）" }
    $release = $got.Json | ConvertFrom-Json
    $upd = Invoke-Api PATCH "$api/releases/$($release.id)" @{ name = $Tag; body = $notes; prerelease = $pre }
    if ($upd.Code -ne '200') { throw "更新 Release 說明失敗（HTTP $($upd.Code))：$(Get-Brief $upd.Json)" }
    foreach ($a in $release.assets) {
        Write-Host "移除舊附件 $($a.name)"
        $d = Invoke-Api DELETE "$api/releases/$($release.id)/assets/$($a.id)"
        if ($d.Code -ne '204') { throw "移除附件 $($a.name) 失敗（HTTP $($d.Code)）" }
    }
    Write-Host "Release $Tag 已存在，已更新說明並重新上傳附件。"
} else {
    $hint = if ($r.Code -eq '401') { '（權杖無效或沒有 repository 寫入權限）' } else { '' }
    throw "建立 Release 失敗（HTTP $($r.Code)）$hint：$(Get-Brief $r.Json)"
}

# 上傳附件
foreach ($f in $files) {
    $name = $f.Name
    Write-Host "上傳 $name ..."
    $out = (curl.exe -sS @auth -X POST "$api/releases/$($release.id)/assets?name=$([uri]::EscapeDataString($name))" -F "attachment=@$($f.Path);filename=$name" -w "`n%{http_code}") -join "`n"
    $c = ($out -split "`n")[-1].Trim()
    if ($c -ne '201') { throw "上傳 $name 失敗（HTTP $c）" }
}
Write-Host "完成：$($release.html_url)"
