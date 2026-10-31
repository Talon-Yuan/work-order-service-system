# deploy_all.ps1 — 微信售后服务平台 V3.1 一键部署引导脚本（阶段9 交付归档）
# 功能：1) 校验环境；2) 同步 common 到全部云函数；3) 云函数依赖安装与部署命令生成；4) 运行全量验收
# 用法：在 PowerShell 中执行  .\scripts\deploy_all.ps1  [-Env prod] [-SkipVerify]
param(
    [string]$Env = "prod",
    [switch]$SkipVerify
)
$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot
$CF = Join-Path $ROOT "cloudfunctions"
$COMMON = Join-Path $CF "common"
$SCRIPTS = Join-Path $ROOT "scripts"

Write-Host "== 微信售后服务平台 V3.1 部署引导 ==" -ForegroundColor Cyan
Write-Host "工程根: $ROOT`n目标环境: $Env`n"

# 1) 环境校验
Write-Host "[1/5] 环境校验" -ForegroundColor Yellow
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Warning "未检测到 node，云函数依赖安装与语法校验将跳过" } else { Write-Host "  node: $($node.Source)" }
$wx = Get-Command tcb -ErrorAction SilentlyContinue
if (-not $wx) { Write-Host "  提示: 未检测到 @cloudbase/cli (tcb)，云函数上传需使用微信开发者工具或 tcb 命令" }

# 2) 同步 common 到全部云函数
Write-Host "[2/5] 同步 common 公共模块到全部云函数" -ForegroundColor Yellow
$fnDirs = Get-ChildItem $CF -Directory | Where-Object { $_.Name -ne "common" }
foreach ($d in $fnDirs) {
    $dst = Join-Path $d.FullName "common"
    if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
    Get-ChildItem $COMMON -File | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $dst $_.Name) -Force
    }
    Write-Host "  已同步 -> $($d.Name)/common"
}

# 3) 云函数依赖安装
Write-Host "[3/5] 云函数依赖安装（含新增 xlsx 等）" -ForegroundColor Yellow
if ($node) {
    foreach ($d in $fnDirs) {
        $pkg = Join-Path $d.FullName "package.json"
        if (Test-Path $pkg) {
            Write-Host "  npm install @ $($d.Name) ..."
            Push-Location $d.FullName
            & npm install --no-audit --no-fund 2>&1 | Out-Host
            Pop-Location
        }
    }
} else {
    Write-Warning "跳过依赖安装（无 node）"
}

# 4) 部署命令生成（微信开发者工具/云开发控制台）
Write-Host "[4/5] 部署指引" -ForegroundColor Yellow
Write-Host @"
  方式A（推荐）：打开微信开发者工具 → 云开发控制台 → 云函数列表 → 逐函数右键「上传并部署：云端安装依赖」。
  需部署云函数（全部 22 个）：
$(($fnDirs | ForEach-Object { "    - " + $_.Name }) -join "`n")
  方式B（CLI）：
    tcb fn deploy login -e $Env
    tcb fn deploy order -e $Env
    ...（逐函数执行）
  部署后请在云开发控制台为每个函数配置环境变量（见 docs/env-template.md），并在微信支付商户平台配置回调地址。
"@

# 5) 全量验收
Write-Host "[5/5] 运行阶段9全量验收" -ForegroundColor Yellow
if (-not $SkipVerify) {
    if (Get-Command python -ErrorAction SilentlyContinue) {
        Push-Location $SCRIPTS
        & python verify_stage9.py
        $code = $LASTEXITCODE
        Pop-Location
        if ($code -ne 0) { Write-Error "验收未通过，请检查 verify_stage9.py 输出" }
        Write-Host "验收通过：全量回归 + 安全自测 + 红线回归 全绿" -ForegroundColor Green
    } else {
        Write-Warning "未检测到 python，跳过验收（请手动运行 scripts/verify_stage9.py）"
    }
}

Write-Host "`n部署引导完成。新工程师按 docs/deploy.md + docs/env-template.md + docs/security-checklist.md 可独立部署。" -ForegroundColor Green
