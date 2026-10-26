' dsh-auth-cookie-guard 无窗口启动器（2026-10-22）
' 背景：计划任务直接执行 powershell.exe，即使加了 -WindowStyle Hidden，
' conhost 仍会为它分配一个控制台并闪出窗口（Interactive 登录类型下无法避免）。
' 改用 wscript.exe（GUI 子系统，进程本身不分配控制台）+ Run(cmd, 0, False)：
'   windowStyle 0 = 隐藏，False = 不等待返回 → 全程零窗口。
' 逻辑本体仍在 dsh-auth-cookie-guard.ps1（带 -Force 参数可跳过进程检查）。

Dim sh, cmd
Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""D:\用户\工具\dsh-auth-cookie-guard.ps1"""
sh.Run cmd, 0, False
Set sh = Nothing