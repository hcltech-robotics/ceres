@echo off
setlocal
call "%~dp0msvc-environment.cmd"
if errorlevel 1 exit /b %errorlevel%
if not defined BUILD_DIRECTORY set "BUILD_DIRECTORY=%~dp0..\build-native"
if defined CUDA_PATH set "CUDACXX=%CUDA_PATH%\bin\nvcc.exe"
cmake -S "%~dp0.." -B "%BUILD_DIRECTORY%" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl %*
exit /b %errorlevel%
