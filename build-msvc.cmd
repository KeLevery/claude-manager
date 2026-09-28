@echo off
rem Load MSVC env then build the Rust backend.
rem Git Bash /usr/bin/link.exe shadows the MSVC linker, so vcvars64 must
rem prepend the MSVC bin dir to PATH before cargo is invoked.
rem CARGO_BUILD_JOBS limits parallel rustc processes to avoid OOM on busy machines.
rem RUST_MIN_STACK gives rustc worker threads bigger stacks; the huge `windows`
rem crate can crash (0xc0000409) with the default stack under memory pressure.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (
  echo [build-msvc] failed to load vcvars64
  exit /b 1
)
set CARGO_BUILD_JOBS=2
set RUST_MIN_STACK=16777216
cd /d "%~dp0src-tauri"
cargo build %*
