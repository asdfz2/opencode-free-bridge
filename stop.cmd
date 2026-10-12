@echo off
chcp 65001 >nul
REM ===== wb-bridge 停止 =====
echo 正在停止 wb-bridge (10000) 和 opencode 后端 (10001)...

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":10000" ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":10001" ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

echo 已停止。
pause
