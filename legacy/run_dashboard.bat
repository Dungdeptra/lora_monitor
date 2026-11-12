@echo off
chcp 65001 >nul
title LoRaMesher Live Monitoring & Log Analyzer
echo =====================================================================
echo   KHOI DONG HE THONG GIAM SAT LORAMESHER (COM SERIAL + WIFI MQTT)
echo =====================================================================

echo.
echo [1/3] Dia chi IPv4 may tinh cua ban (dung neu bat Wi-Fi MQTT):
ipconfig | findstr /i "IPv4"

echo.
echo [2/3] Kiem tra Mosquitto MQTT Broker (Port 1883)...
net start mosquitto 2>nul
if exist "C:\Program Files\mosquitto\mosquitto.exe" (
    tasklist /FI "IMAGENAME eq mosquitto.exe" 2>NUL | find /I /N "mosquitto.exe">NUL
    if "%ERRORLEVEL%"=="1" (
        start "Mosquitto Broker" "C:\Program Files\mosquitto\mosquitto.exe" -v
    )
)

echo.
echo [3/3] Khoi dong Web Server tai http://localhost:8000 ...
cd /d "%~dp0server"
start http://localhost:8000
python -m uvicorn app:app --host 0.0.0.0 --port 8000
pause
