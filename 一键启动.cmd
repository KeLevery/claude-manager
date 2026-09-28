@echo off
chcp 65001 >nul
title claude-manager 一键启动
cd /d "%~dp0"

echo [1/3] 检查依赖...
if not exist "node_modules" (
    echo       首次运行，安装依赖（约 1-2 分钟）...
    call npm install
    if errorlevel 1 goto :fail
)

echo [2/3] 检查端口 1420...
netstat -ano | findstr /r /c:":1420 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":1420 .*LISTENING"') do (
        echo       清理占用端口的残留进程 PID %%p
        taskkill /PID %%p /F >nul 2>&1
    )
)

echo [3/3] 启动应用（编译改动需要几十秒，窗口随后自动打开）...
rem 限制 cargo 并行编译进程数并加大 rustc 线程栈，避免内存紧张时编译崩溃
set CARGO_BUILD_JOBS=2
set RUST_MIN_STACK=16777216
call npm run tauri dev
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo [启动失败] 请把上面的错误信息复制给助手排查。
pause
