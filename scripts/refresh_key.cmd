@echo off
REM Refresh COC_API_TOKEN for this machine's current public IP.
REM
REM Register it to self-heal a rotating IP (every 30 minutes):
REM   schtasks /Create /TN "CoC API key refresh" /SC MINUTE /MO 30 ^
REM     /TR "E:\CODING FILE\coc-attack-tracker\scripts\refresh_key.cmd" /F
REM Remove it again with:
REM   schtasks /Delete /TN "CoC API key refresh" /F
cd /d "%~dp0.."
python scripts\refresh_key.py --quiet
exit /b %ERRORLEVEL%
