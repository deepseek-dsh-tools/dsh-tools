@echo off
chcp 65001 >nul
setlocal
echo ==== DSH Auth Cookie doctor ====
"%~dp0pythons\cpython-3.12.15-windows-x86_64-none\python.exe" "%~dp0dsh-auth-cookie-doctor.py" %*
echo.
pause