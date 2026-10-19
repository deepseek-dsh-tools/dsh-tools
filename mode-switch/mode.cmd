@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\DeepSeek Harness.exe" "%~dp0mode.mjs" %*
exit /b %errorlevel%
