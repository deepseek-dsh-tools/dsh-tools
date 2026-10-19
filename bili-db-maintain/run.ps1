# bili index.db 维护任务包装（PowerShell 5.1 兼容，文件必须带 BOM）
$ErrorActionPreference = 'Continue'
$Base = 'D:\DSH\.dsh\cache\bili-db-maintain'
$Py   = 'D:\用户\工具\pythons\cpython-3.12.15-windows-x86_64-none\python.exe'
$Script = Join-Path $Base 'maintain.py'
$Log  = Join-Path $Base 'task.log'

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$env:PYTHONIOENCODING = 'utf-8'

"===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 触发 =====" | Out-File -FilePath $Log -Append -Encoding utf8
if (-not (Test-Path $Py)) {
    "异常: 找不到 python: $Py" | Out-File -FilePath $Log -Append -Encoding utf8
    exit 2
}
& $Py $Script vacuum --threshold-mb 1024 2>&1 | Out-File -FilePath $Log -Append -Encoding utf8
"退出码: $LASTEXITCODE" | Out-File -FilePath $Log -Append -Encoding utf8
