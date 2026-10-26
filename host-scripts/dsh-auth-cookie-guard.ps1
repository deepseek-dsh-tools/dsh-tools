# dsh-auth-cookie-guard.ps1
#
# 目的：DSH Desktop 每次启动前，把 userData 里累积的 dsh-auth-* cookie 压回安全水位。
# 背景：host 每个启动周期签发一个新名字的 cookie（30 天过期、旧的从不撤销），
#       而 D:\DSH\resources\app\lib\main.js:12244 把所有 cookie 拼成一个 Cookie 头，
#       累积到 71 个 ≈ 16186 字节，加上 Host/UA 就顶穿 Node maxHeaderSize=16384 →
#       启动抛 desktop welcome: Web authentication failed。
#
# 策略（对应 doublecheck spec 的优先级）：
#   ① DSH 只要在跑就立刻退出，绝不碰库、绝不写日志噪音
#   ② DSH 不在跑 且 dsh-auth-* 超过 $Min 个 → 清到只留 $Keep 个
#   ③ 由计划任务每 3 分钟触发一次；DSH 退出后最多 3 分钟就清干净
#
# 手动用法：powershell -NoProfile -ExecutionPolicy Bypass -File 本文件

param(
    # -Force：跳过「DSH 是否在跑」的检查。只在两种情况下用：
    #   ① 自测（拿假 APPDATA + 假库验证清理路径）② DSH 已退出但进程名被占用导致误判。
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$Log  = 'D:\用户\工具\dsh-auth-cookie-guard.log'
$Py   = 'D:\用户\工具\pythons\cpython-3.12.15-windows-x86_64-none\python.exe'
$Tool = 'D:\用户\工具\dsh-auth-cookie-doctor.py'
$Min  = 20      # 水位：不超过这个数就不清
$Keep = 1       # 清理后保留最近访问的几个

function Write-GuardLog([string]$Message) {
    try {
        $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
        Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
        # 日志自我裁剪：超过 300 行只留最近 100 行
        $all = @(Get-Content -LiteralPath $Log -Encoding UTF8 -ErrorAction SilentlyContinue)
        if ($all.Count -gt 300) {
            Set-Content -LiteralPath $Log -Value ($all[-100..-1]) -Encoding UTF8
        }
    } catch { }
}

# ── ① DSH 在跑：立刻走人（这是最常见的路径，什么都不做才叫安全）──────────
$dsh = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($null -ne $dsh -and -not $Force) { exit 0 }

# ── ② 依赖缺失：留一行日志，退出码 1（不写噪音，只在真出事时记）──────────
if (-not (Test-Path -LiteralPath $Py))   { Write-GuardLog "ERROR python 不存在: $Py";   exit 1 }
if (-not (Test-Path -LiteralPath $Tool)) { Write-GuardLog "ERROR 工具不存在: $Tool";     exit 1 }

# ── ③ 判定水位并清理 ───────────────────────────────────────────────────
try {
    $out  = (& $Py $Tool --clean --keep $Keep --min $Min 2>&1 | Out-String)
    $code = $LASTEXITCODE
} catch {
    Write-GuardLog "ERROR 调用失败: $($_.Exception.Message)"
    exit 1
}

if ($out -match '已删除 (\d+) 个') {
    Write-GuardLog ('CLEANED {0} 个 dsh-auth-*（水位 {1}，保留 {2}）' -f $Matches[1], $Min, $Keep)
    $sizes = [regex]::Matches($out, 'Cookie 头估算 : (\d+) 字节')
    if ($sizes.Count -ge 2) {
        Write-GuardLog ('  Cookie 头 {0} → {1} 字节' -f $sizes[0].Groups[1].Value, $sizes[$sizes.Count - 1].Groups[1].Value)
    }
} elseif ($code -ne 0) {
    # 库被别的进程短暂占用、或路径变了：记一行就撤，不重试不打扰
    Write-GuardLog ('WARN exit={0} {1}' -f $code, ($out.Trim() -replace '\s+', ' '))
}

exit 0
