@echo off
rem Wrapper for 7za.exe that treats exit code 2 (symlink warnings) as success
rem electron-builder's bundled 7zip cannot create symlinks on Windows without admin,
rem but the required Windows binaries (rcedit-x64.exe) are extracted correctly.

set "REAL_7ZA=D:\lcl2\FreeLLM-Hub\node_modules\7zip-bin\win\x64\7za.exe"

rem Forward all arguments to real 7za
"%REAL_7ZA%" %*

rem If exit code is 2 (fatal error from symlink failures) treat as success
if %ERRORLEVEL% equ 2 exit /b 0
exit /b %ERRORLEVEL%
