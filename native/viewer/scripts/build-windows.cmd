@echo off
setlocal
call "%~dp0msvc-environment.cmd"
if errorlevel 1 exit /b %errorlevel%
if not defined BUILD_DIRECTORY set "BUILD_DIRECTORY=%~dp0..\build-native"
cmake --build "%BUILD_DIRECTORY%" --parallel 8 %*
exit /b %errorlevel%
