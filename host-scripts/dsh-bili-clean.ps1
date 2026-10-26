<#
.SYNOPSIS
  dsh-bili-clean.ps1 —— 清理 billion-context 状态目录里的历史垃圾

.DESCRIPTION
  清两样，别的一概不动：
    1) <root>\retrieve\img\   下超过 KeepDays 天的原图副本（acp_read_original_image 的落盘）
    2) <root>\bili.log.old    超过 KeepDays 天的日志归档

  刻意不动的：
    - retrieve\*.txt   （含对话正文，但总量小，留着可回溯）
    - bili.log         （正在被写，动了会丢日志）
    - prefix-affinity.json / session-order.json（bili 的索引文件，动了可能影响缓存亲和）
    - instances\ / writers\ / port-zone.json 等运行态

.PARAMETER KeepDays
  保留最近多少天，默认 7

.PARAMETER Root
  billion-context 状态目录，默认 %USERPROFILE%\.local\state\billion-context
  （测试时用这个参数指到假目录）

.PARAMETER DryRun
  只报告不删

.PARAMETER Quiet
  不输出（计划任务用）

.EXAMPLE
  .\dsh-bili-clean.ps1 -DryRun
  .\dsh-bili-clean.ps1 -KeepDays 3
#>
[CmdletBinding()]
param(
    [int]$KeepDays = 7,
    [string]$Root = '',
    [switch]$DryRun,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Join-Path $env:USERPROFILE '.local\state\billion-context'
}

$logPath = if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    Join-Path $env:TEMP 'dsh-bili-clean.log'
} else {
    Join-Path $PSScriptRoot 'dsh-bili-clean.log'
}

function Write-Log([string]$msg) {
    if (-not $Quiet) { Write-Host $msg }
}

$cutoff = (Get-Date).AddDays(-$KeepDays)
$report = [ordered]@{
    root        = $Root
    keepDays    = $KeepDays
    dryRun      = [bool]$DryRun
    cutoff      = $cutoff.ToString('yyyy-MM-dd HH:mm:ss')
    imgDeleted  = 0
    imgFreedKB  = 0
    logArchived = $false
    logFreedKB  = 0
    keptTxt     = 0
    totalMB     = 0
    errors      = @()
}

if (-not (Test-Path $Root)) {
    Write-Log "状态目录不存在，无事可做: $Root"
    return $report
}

# ── 1) retrieve\img\ 下过期原图 ──────────────────────────────
$imgDir = Join-Path $Root 'retrieve\img'
if (Test-Path $imgDir) {
    $old = Get-ChildItem $imgDir -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $cutoff }
    if ($old) {
        $freed = ($old | Measure-Object Length -Sum).Sum
        if ($DryRun) {
            Write-Log ("[dry-run] 将删除 img/ 下 {0} 个文件，释放 {1:N1} MB" -f $old.Count, ($freed / 1MB))
        } else {
            foreach ($f in $old) {
                try { Remove-Item $f.FullName -Force -ErrorAction Stop }
                catch { $report.errors += "删除失败 $($f.Name): $($_.Exception.Message)" }
            }
            Write-Log ("已删除 img/ 下 {0} 个文件，释放 {1:N1} MB" -f $old.Count, ($freed / 1MB))
        }
        $report.imgDeleted = $old.Count
        $report.imgFreedKB = [int]($freed / 1KB)
    } else {
        Write-Log "img/ 下没有超过 $KeepDays 天的文件"
    }
    # img 目录本身空了也不删（bili 可能还要用）
} else {
    Write-Log "img/ 目录不存在，跳过"
}

# ── 2) bili.log.old ─────────────────────────────────────────
$logOld = Join-Path $Root 'bili.log.old'
if (Test-Path $logOld) {
    $li = Get-Item $logOld
    if ($li.LastWriteTime -lt $cutoff) {
        if ($DryRun) {
            Write-Log ("[dry-run] 将删除 bili.log.old，释放 {0:N1} MB" -f ($li.Length / 1MB))
        } else {
            try {
                Remove-Item $logOld -Force -ErrorAction Stop
                Write-Log ("已删除 bili.log.old，释放 {0:N1} MB" -f ($li.Length / 1MB))
                $report.logArchived = $true
                $report.logFreedKB = [int]($li.Length / 1KB)
            } catch {
                $report.errors += "删除 bili.log.old 失败: $($_.Exception.Message)"
            }
        }
        if ($DryRun) { $report.logFreedKB = [int]($li.Length / 1KB) }
    } else {
        Write-Log "bili.log.old 未超过 $KeepDays 天，保留"
    }
} else {
    Write-Log "bili.log.old 不存在，跳过"
}

# ── 3) 报告现状（不动 *.txt）─────────────────────────────────
$txt = Get-ChildItem (Join-Path $Root 'retrieve') -Filter '*.txt' -File -ErrorAction SilentlyContinue
$report.keptTxt = @($txt).Count
$all = Get-ChildItem $Root -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object Length -Sum
$report.totalMB = [Math]::Round($all.Sum / 1MB, 2)
Write-Log ("现状: 目录共 {0:N1} MB；保留 txt {1} 个（{2:N1} MB）" -f `
    ($all.Sum / 1MB), $report.keptTxt, (($txt | Measure-Object Length -Sum).Sum / 1MB))

# 只有真的删了东西才写日志文件
if (-not $DryRun -and ($report.imgDeleted -gt 0 -or $report.logArchived)) {
    $line = "{0} keep={1}d img={2}({3:N1}MB) log={4}({5:N1}MB) total={6}MB" -f `
        (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $KeepDays, $report.imgDeleted,
        ($report.imgFreedKB / 1024), [int]$report.logArchived, ($report.logFreedKB / 1024), $report.totalMB
    try {
        Add-Content -LiteralPath $logPath -Value $line -Encoding utf8 -ErrorAction Stop
        # 日志本身超过 300 行就截到 100
        $lines = Get-Content $logPath -ErrorAction SilentlyContinue
        if ($lines.Count -gt 300) {
            $lines | Select-Object -Last 100 | Set-Content $logPath -Encoding utf8
        }
    } catch { }
}

return $report
