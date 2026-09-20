@echo off
if defined VSCMD_VER exit /b 0
set "CERES_VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%CERES_VSWHERE%" (
  echo Visual Studio Installer with the C++ build tools is required.
  exit /b 1
)
if not defined CERES_VS_INSTALL for /f "usebackq tokens=*" %%i in (`call "%CERES_VSWHERE%" -latest -version "[17.0,18.0)" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "CERES_VS_INSTALL=%%i"
if not defined CERES_VS_INSTALL (
  echo Visual Studio C++ build tools were not found.
  exit /b 1
)
if defined CERES_MSVC_TOOLSET (
  call "%CERES_VS_INSTALL%\VC\Auxiliary\Build\vcvars64.bat" -vcvars_ver=%CERES_MSVC_TOOLSET% >nul
) else (
  call "%CERES_VS_INSTALL%\VC\Auxiliary\Build\vcvars64.bat" >nul
)
exit /b %errorlevel%
