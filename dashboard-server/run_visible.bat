@echo off
cd /d "d:\Bubble_AI\dashboard-server"
echo Checking and installing package dependencies...
cmd.exe /c npm install

echo Starting Bubble Microservices...

:: Start Search / Chrome Service (port 3002) in the background
start "Bubble Search Service" /min cmd /c "set PORT=3002 && node searchService.js"

:: Start RTSP Camera Vision Service (port 3003) in the background
start "Bubble RTSP Vision Service" /min cmd /c "set PORT=3003 && node visionService.js"

:: Start Main Dashboard Server (port 3001) in the foreground
echo Starting Bubble AI Main Server on port 3001...
set PORT=3001
"C:\Program Files\nodejs\node.exe" server.js
pause
