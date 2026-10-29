<#
.SYNOPSIS
    delta-agent Windows 一键安装脚本（F-51 AC-51-1）。

.DESCRIPTION
    安装闭环：检测/安装 Node.js（>= 20，可选）→ npm 全局安装 delta → 验证 delta --version。
    - Node 安装依次尝试 winget / chocolatey / 官网 MSI 静默安装；已有合规 Node 时跳过。
    - 通过 -Package 指定安装来源：npm 包名（默认 @delta/cli）、本地目录或 .tgz 路径均可。
    - 通过 -Registry 指定内网 npm 镜像（信创离线场景配合离线包使用）。

.PARAMETER Package
    要全局安装的 npm 包名 / 本地目录 / tgz 路径，默认 @delta/cli。

.PARAMETER NodeVersion
    缺省要求的主版本（默认 20 = LTS）。

.PARAMETER Registry
    可选 npm registry（内网镜像），如 http://npm.internal.local/。

.PARAMETER NoNodeInstall
    只检测 Node，缺失时不自动安装（报错并提示手动安装）。

.EXAMPLE
    # 在线安装（npm 发布渠道）
    powershell -ExecutionPolicy Bypass -File .\install-windows.ps1

.EXAMPLE
    # 从本地构建产物安装（离线包 / CI 工件）
    powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Package .\delta-cli-0.1.0.tgz
#>
[CmdletBinding()]
param(
    [string]$Package = '@delta/cli',
    [int]$NodeVersion = 20,
    [string]$Registry = '',
    [switch]$NoNodeInstall
)

$ErrorActionPreference = 'Stop'
$Exit_NodeMissing = 2
$Exit_NpmFail = 3
$Exit_VerifyFail = 4

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "  ✔ $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  ⚠ $msg" -ForegroundColor Yellow }

# 从注册表合并机器 + 用户 PATH（安装器改写 PATH 后无需重启即可见）
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Get-NodeMajor {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $null }
    try {
        $v = (& node --version) -replace '^v', ''
        return [int]($v.Split('.')[0])
    } catch {
        return $null
    }
}

# ── 1. Node.js ──────────────────────────────────────────────────────────
Write-Step "检查 Node.js >= $NodeVersion"
$major = Get-NodeMajor
if ($major -and $major -ge $NodeVersion) {
    Write-Ok "Node $(& node --version) 已就绪"
} else {
    if ($NoNodeInstall) {
        Write-Host "  ✘ 未检测到 Node >= $NodeVersion（-NoNodeInstall 已禁用自动安装）" -ForegroundColor Red
        exit $Exit_NodeMissing
    }
    Write-Warn2 "未检测到 Node >= $NodeVersion，尝试自动安装 LTS…"
    $installed = $false
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host '  通过 winget 安装 OpenJS.NodeJS.LTS …'
        try {
            winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
            if ($LASTEXITCODE -eq 0) { $installed = $true }
        } catch { Write-Warn2 "winget 安装失败：$($_.Exception.Message)" }
    }
    if (-not $installed -and (Get-Command choco -ErrorAction SilentlyContinue)) {
        Write-Host '  通过 chocolatey 安装 nodejs-lts …'
        try {
            choco install nodejs-lts -y --no-progress
            if ($LASTEXITCODE -eq 0) { $installed = $true }
        } catch { Write-Warn2 "choco 安装失败：$($_.Exception.Message)" }
    }
    if (-not $installed) {
        # 兜底：官网 MSI 静默安装（x64 / arm64）
        $arch = if ([Environment]::Is64BitOperatingSystem -and $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        $url = "https://nodejs.org/dist/latest-v$NodeVersion.x/node-v-latest-win-$arch.msi"
        # latest 目录里文件名带真实版本号，先解析目录索引拿准确文件名
        try {
            Write-Host "  解析 nodejs.org latest-v$NodeVersion.x 目录（$arch）…"
            $index = (Invoke-WebRequest -Uri "https://nodejs.org/dist/latest-v$NodeVersion.x/" -UseBasicParsing).Content
            $match = [regex]::Match($index, "node-v([\d.]+)-win-$arch\.msi")
            if ($match.Success) {
                $msiName = $match.Groups[0].Value
                $url = "https://nodejs.org/dist/latest-v$NodeVersion.x/$msiName"
                $msiPath = Join-Path $env:TEMP $msiName
                Write-Host "  下载 $url …"
                Invoke-WebRequest -Uri $url -OutFile $msiPath -UseBasicParsing
                Write-Host '  静默安装 MSI（需要管理员权限）…'
                Start-Process msiexec -ArgumentList "/i `"$msiPath`" /qn /norestart" -Wait -Verb RunAs
                $installed = $true
            }
        } catch { Write-Warn2 "MSI 安装失败：$($_.Exception.Message)" }
    }
    if (-not $installed) {
        Write-Host '  ✘ 自动安装 Node 失败。请手动安装：https://nodejs.org（LTS）后重跑本脚本' -ForegroundColor Red
        exit $Exit_NodeMissing
    }
    Update-SessionPath
    $major = Get-NodeMajor
    if (-not $major -or $major -lt $NodeVersion) {
        Write-Host '  ✘ Node 安装后仍不可用（可能需要重开终端刷新 PATH）' -ForegroundColor Red
        exit $Exit_NodeMissing
    }
    Write-Ok "Node $(& node --version) 安装完成"
}

# ── 2. npm 全局安装 delta ───────────────────────────────────────────────
Write-Step "npm 安装 $Package"
$npmArgs = @('install', '-g', $Package)
if ($Registry -ne '') { $npmArgs += @('--registry', $Registry) }
& npm @npmArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✘ npm install -g 失败（exit $LASTEXITCODE）。网络/镜像/权限问题请排查后重试" -ForegroundColor Red
    exit $Exit_NpmFail
}
Write-Ok "$Package 安装完成"

# ── 3. 验证 delta --version ─────────────────────────────────────────────
Update-SessionPath  # npm 全局 bin（%APPDATA%\npm）刚写入 PATH，合并注册表后立即可见
Write-Step '验证 delta --version'
$delta = Get-Command delta -ErrorAction SilentlyContinue
if (-not $delta) {
    # npm 全局 bin 不在 PATH 时的兜底定位
    $candidate = Join-Path $env:APPDATA 'npm\delta.cmd'
    if (Test-Path $candidate) {
        Write-Warn2 "$env:APPDATA\npm 不在 PATH 中，正在追加到用户 PATH"
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        [Environment]::SetEnvironmentVariable('Path', "$userPath;$env:APPDATA\npm", 'User')
        $env:Path = "$env:Path;$env:APPDATA\npm"
        $delta = @{ Source = $candidate }
    } else {
        Write-Host "  ✘ 找不到 delta 命令。请重开终端后再试，或手动检查 npm 全局 bin 目录" -ForegroundColor Red
        exit $Exit_VerifyFail
    }
}
$version = & delta --version 2>$null
if (-not $version) {
    Write-Host '  ✘ delta --version 无输出，安装不完整' -ForegroundColor Red
    exit $Exit_VerifyFail
}
Write-Ok "delta $($version) 就绪"

Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host '  delta doctor        # 环境自检（Node/配置/数据库/连通性）'
Write-Host '  delta models add    # 配置模型 Provider'
Write-Host '  delta run "任务"    # 开始第一个任务'
