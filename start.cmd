@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ===== wb-bridge 一键启动 =====
REM 密码和数据目录在 config.local.json 里，由 launch-backend.mjs 显式注入，
REM 不再依赖批处理的环境变量传递（以前那种方式会导致前后端密码不一致）

REM 先清掉旧实例（仅按端口杀，保证每次都是全新一致的状态）
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":10000" ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":10001" ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1
timeout /t 2 /nobreak >nul

echo [1/2] 启动 opencode 后端（独立数据目录，会话不再进 OpenChamber）...
start "opencode-backend" /min node launch-backend.mjs
timeout /t 8 /nobreak >nul

echo [2/2] 启动 wb-bridge 桥接...
start "wb-bridge" /min node bridge.mjs
timeout /t 5 /nobreak >nul

REM 自检：模型数大于 0 才算成功
for /f %%r in ('powershell -NoProfile -Command "(Invoke-RestMethod http://127.0.0.1:10000/health).models"') do set MODELS=%%r
if "%MODELS%"=="0" (
  echo.
  echo [自检失败] 桥接没有连上后端。请重跑本脚本，不行就截图发给助手。
) else (
  echo [自检通过] 在线模型数: %MODELS%
)

echo.
echo ====================================================
echo   启动完成，本窗口可以关掉。
echo.
echo   其他 OpenAI 兼容工具用：
echo     接口地址  http://127.0.0.1:10000/v1
echo     API 密钥  wb2026free
echo     模型名    opencode/longcat-2.5-preview-free
echo ====================================================
echo.
pause
