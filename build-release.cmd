@echo off
rem Build the release version (NSIS installer + standalone exe).
rem vcvars64 is required for the MSVC linker; job limit + big rustc stacks
rem keep the build stable on memory-constrained machines.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (
  echo [build-release] failed to load vcvars64
  exit /b 1
)
set CARGO_BUILD_JOBS=2
set RUST_MIN_STACK=16777216
cd /d "%~dp0"
call npm run tauri build -- --bundles nsis
