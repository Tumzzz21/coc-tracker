@echo off
REM One-command local start: checks MySQL, prints the setup report, runs the app.
cd /d "%~dp0.."

netstat -an | findstr ":3306" | findstr "LISTENING" >nul
if errorlevel 1 (
  echo [warn] MySQL is not listening on port 3306.
  if exist "C:\xampp\mysql_start.bat" (
    echo        starting XAMPP MySQL...
    start "" /b "C:\xampp\mysql_start.bat"
    timeout /t 8 /nobreak >nul
  ) else (
    echo        start MySQL yourself, then run this again.
  )
)

python scripts\diagnose.py
echo.
echo Starting the tracker on http://localhost:5000 ...
python app.py
