$ErrorActionPreference = "Stop"
$projectRoot = "D:\lcl2\FreeLLM-Hub"
$electronDir = "$projectRoot\release\win-unpacked"
$outputDir = "C:\temp\freellm-release\FreeLLM Hub-win32-x64"

Write-Host "[1/6] Checking unpacked dir..." -ForegroundColor Cyan
if (-not (Test-Path $electronDir)) { Write-Error "Missing: $electronDir" }

Write-Host "[2/6] Killing existing processes..." -ForegroundColor Cyan
Get-Process -Name "FreeLLM Hub" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Write-Host "[3/6] Copying Electron dir..." -ForegroundColor Cyan
if (Test-Path $outputDir) { Remove-Item $outputDir -Recurse -Force }
Copy-Item $electronDir $outputDir -Recurse

Write-Host "[4/6] Preparing resources/app..." -ForegroundColor Cyan
$appDir = "$outputDir\resources\app"
if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force }
New-Item -ItemType Directory $appDir -Force | Out-Null
Copy-Item "$projectRoot\package.json" "$appDir\" -Force
Copy-Item "$projectRoot\dist" "$appDir\dist" -Recurse -Force
New-Item -ItemType Directory "$appDir\resources\default-config" -Force | Out-Null
Copy-Item "$projectRoot\resources\default-config\*" "$appDir\resources\default-config\" -Recurse -Force

Write-Host "[5/6] Copying production deps..." -ForegroundColor Cyan
node "$projectRoot\scripts\copy-prod-deps.cjs"

Write-Host "[6/6] Removing stale asar files..." -ForegroundColor Cyan
Remove-Item "$outputDir\resources\app.asar" -Force -ErrorAction SilentlyContinue
Remove-Item "$outputDir\resources\app.asar.unpacked" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done: $outputDir" -ForegroundColor Green
$size = [math]::Round((Get-Item "$outputDir\FreeLLM Hub.exe").Length / 1MB, 1)
Write-Host "Size: $size MB" -ForegroundColor Green
