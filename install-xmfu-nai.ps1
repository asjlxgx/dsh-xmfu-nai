<#
  dsh-xmfu-nai 安装脚本 (Windows)
  用法:
    powershell -ExecutionPolicy Bypass -File install-xmfu-nai.ps1
    powershell -ExecutionPolicy Bypass -File install-xmfu-nai.ps1 -DshHome "C:\Users\you\.dsh"

  做的事:
    1) 定位 DSH_HOME
    2) 复制插件到 <DSH_HOME>\plugins\dsh-xmfu-nai
    3) 登记到 desktop + web profile
    4) 给两个 profile 建 node_modules Junction
    5) 校验并提示重启
#>

param(
    [string]$DshHome
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-xmfu-nai'
$SourceDir  = $PSScriptRoot
$Profiles   = @('desktop', 'web')

function Write-Step($msg) { Write-Host "`n[>] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    !   $msg" -ForegroundColor Yellow }

# ---------- 1. 定位 DSH_HOME ----------
if (-not $DshHome) {
    $candidates = @(
        (Join-Path $env:APPDATA 'dsh-desktop\harness'),
        (Join-Path $env:APPDATA 'DSH\harness'),
        (Join-Path $env:APPDATA 'dsh\harness'),
        (Join-Path $env:LOCALAPPDATA 'dsh-desktop\harness'),
        (Join-Path $env:USERPROFILE '.dsh'),
        (Join-Path $env:USERPROFILE '.dsh\harness')
    )
    foreach ($c in $candidates) {
        if (Test-Path (Join-Path $c 'profiles')) { $DshHome = $c; break }
    }
    if (-not $DshHome) {
        foreach ($root in @($env:APPDATA, $env:LOCALAPPDATA, 'D:\', 'C:\')) {
            $hit = Get-ChildItem -Path $root -Directory -Filter 'harness' -Recurse -Depth 3 -ErrorAction SilentlyContinue |
                   Where-Object { Test-Path (Join-Path $_.FullName 'profiles') } |
                   Select-Object -First 1
            if ($hit) { $DshHome = $hit.FullName; break }
        }
    }
}

if (-not $DshHome -or -not (Test-Path $DshHome)) {
    Write-Host "`n[X] 没找到 DSH_HOME。" -ForegroundColor Red
    Write-Host "    手动指定路径：" -ForegroundColor Yellow
    Write-Host '      powershell -ExecutionPolicy Bypass -File install-xmfu-nai.ps1 -DshHome "C:\Users\you\.dsh"' -ForegroundColor Yellow
    exit 1
}
Write-Step "DSH_HOME = $DshHome"
Write-Ok "已定位"

# ---------- 2. 复制插件 ----------
Write-Step "复制插件到 <DSH_HOME>\plugins\$PluginName"
$pluginsDir = Join-Path $DshHome 'plugins'
$targetDir  = Join-Path $pluginsDir $PluginName
if (-not (Test-Path $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null }
if (Test-Path $targetDir) {
    Write-Warn2 "目标已存在，先移除旧副本"
    Remove-Item $targetDir -Recurse -Force
}
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
Get-ChildItem $SourceDir -Force | Where-Object { $_.Name -notin @('.git') } | ForEach-Object {
    Copy-Item $_.FullName -Destination $targetDir -Recurse -Force
}
Write-Ok "已复制 -> $targetDir"

# ---------- 3. 登记 profile ----------
Write-Step "登记到 desktop + web profile"
$depValue = "link:../../plugins/$PluginName"
foreach ($profile in $Profiles) {
    $profileDir = Join-Path $DshHome ("profiles\" + $profile)
    $profilePkg = Join-Path $profileDir 'package.json'
    if (-not (Test-Path $profilePkg)) {
        Write-Warn2 "跳过不存在的 $profilePkg"
        continue
    }

    Write-Step "登记 profile: $profile"
    $bak = "$profilePkg.bak-xmfu-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $profilePkg $bak -Force
    Write-Ok "已备份 -> $bak"

    $raw = [System.IO.File]::ReadAllText($profilePkg)
    $raw = $raw.TrimStart([char]0xFEFF)
    $cfg = $raw | ConvertFrom-Json

    if (-not $cfg.PSObject.Properties['dependencies']) {
        $cfg | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if ($cfg.dependencies.PSObject.Properties[$PluginName]) {
        $cfg.dependencies.$PluginName = $depValue
    } else {
        $cfg.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue $depValue -Force
    }
    Write-Ok "dependencies.$PluginName = $depValue"

    if (-not $cfg.PSObject.Properties['dsh']) {
        $cfg | Add-Member -NotePropertyName 'dsh' -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if (-not $cfg.dsh.PSObject.Properties['profile']) {
        $cfg.dsh | Add-Member -NotePropertyName 'profile' -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if (-not $cfg.dsh.profile.PSObject.Properties['bundles']) {
        $cfg.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue @() -Force
    }
    $bundles = @($cfg.dsh.profile.bundles)
    if ($bundles -notcontains $PluginName) { $bundles += $PluginName }
    $cfg.dsh.profile.bundles = $bundles
    Write-Ok "dsh.profile.bundles 含 $PluginName (共 $($bundles.Count) 项)"

    $json = $cfg | ConvertTo-Json -Depth 32
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($profilePkg, $json, $utf8NoBom)
    Write-Ok "已写回（UTF-8 无 BOM）"
}

# ---------- 4. Junction ----------
Write-Step "建 node_modules Junction（desktop + web）"
foreach ($profile in $Profiles) {
    $profileDir = Join-Path $DshHome ("profiles\" + $profile)
    if (-not (Test-Path $profileDir)) { continue }
    $nmDir = Join-Path $profileDir 'node_modules'
    if (-not (Test-Path $nmDir)) { New-Item -ItemType Directory -Path $nmDir -Force | Out-Null }
    $linkPath = Join-Path $nmDir $PluginName

    if (Test-Path $linkPath) {
        $item = Get-Item $linkPath -Force -ErrorAction SilentlyContinue
        if ($item.LinkType -eq 'Junction') {
            Write-Warn2 "$profile Junction 已存在，重建"
            [System.IO.Directory]::Delete($linkPath, $false)
        } else {
            Write-Warn2 "$profile 同名实体目录已存在，移除"
            Remove-Item $linkPath -Recurse -Force
        }
    }
    try {
        New-Item -ItemType Junction -Path $linkPath -Target $targetDir | Out-Null
        Write-Ok "$profile Junction: $linkPath -> $targetDir"
    } catch {
        Write-Warn2 "$profile Junction 失败: $($_.Exception.Message)"
        Write-Warn2 "改用 pnpm install 或手动建链接"
    }
}

# ---------- 5. 校验 ----------
Write-Step "校验"
$idx = Join-Path $targetDir 'lib\index.js'
if (Test-Path $idx) {
    node --check $idx 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Ok "lib/index.js 语法通过" }
    else { Write-Warn2 "lib/index.js 语法检查失败" }
} else { Write-Warn2 "缺少 lib/index.js" }

$pkgJson = Join-Path $targetDir 'package.json'
if (Test-Path $pkgJson) {
    $pb = [System.IO.File]::ReadAllBytes($pkgJson)
    if ($pb.Length -ge 3 -and $pb[0] -eq 0xEF -and $pb[1] -eq 0xBB -and $pb[2] -eq 0xBF) {
        Write-Warn2 "package.json 有 UTF-8 BOM，正在剥离"
        [System.IO.File]::WriteAllBytes($pkgJson, $pb[3..($pb.Length-1)])
        Write-Ok "BOM 已剥离"
    } else {
        Write-Ok "package.json 无 BOM"
    }
}

Write-Host "`n============================================" -ForegroundColor Green
Write-Host " 安装完成" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host @"

下一步:
  1. 完全退出 DSH，重新启动
  2. 打开 设置 -> XMFU NAI
  3. 填 pst-xmfu- API Key，或在 ~/.credentials.yaml 里写 XMFU_API_KEY
  4. 对话里说「用 xmfu 画一张 1girl, silver hair, fox ears ...」

凭据文件: $DshHome\xmfu-nai\config.json
图片目录: $DshHome\media\xmfu-nai
卸载: 删除 plugins\$PluginName，并从 desktop/web profile 的 package.json 移除对应两行
"@ -ForegroundColor Gray
