#!/bin/bash
# Manual packaging using cached Electron binary
# Avoids electron-builder's winCodeSign dependency

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_PARENT="C:/temp/freellm-release"
OUT_DIR="${OUT_PARENT}/FreeLLM Hub-win32-x64"

# Clean previous
rm -rf "${OUT_PARENT}"
mkdir -p "${OUT_PARENT}"

# Electron version
ELECTRON_VERSION="33.4.11"
ELECTRON_ZIP="${HOME}/AppData/Local/electron/Cache/electron-v${ELECTRON_VERSION}-win32-x64.zip"

if [ ! -f "$ELECTRON_ZIP" ]; then
  echo "Electron ${ELECTRON_VERSION} not found in cache at: ${ELECTRON_ZIP}"
  echo "Falling back to electron-builder download..."
  # Place a stub .electronrc to use mirror if needed
  export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  npx @electron/get --version=${ELECTRON_VERSION} --platform=win32 --arch=x64
  ELECTRON_ZIP="${HOME}/.electron/electron-v${ELECTRON_VERSION}-win32-x64.zip"
fi

if [ ! -f "$ELECTRON_ZIP" ]; then
  echo "ERROR: Still cannot find Electron zip"
  exit 1
fi

echo "Using Electron zip: ${ELECTRON_ZIP}"

# Unzip Electron to output directory
echo "Extracting Electron..."
cd "${OUT_PARENT}"
unzip -q -o "$ELECTRON_ZIP"

# Apply icon (best-effort, skip if rcedit not available)
if command -v rcedit &> /dev/null; then
  echo "Applying icon..."
  Wine rcedit-x64.exe "FreeLLM Hub.exe" --set-icon "${ROOT}/resources/icons/icon.ico" 2>/dev/null || true
fi

# Rename FreeLLM Hub.exe to itself (it already comes as electron.exe renamed)
# Copy our app into resources/app (no asar)
echo "Copying application files..."
rm -rf "${OUT_DIR}/resources/app"
mkdir -p "${OUT_DIR}/resources/app"

# Copy compiled main + renderer
cp -R "${ROOT}/dist/"* "${OUT_DIR}/resources/app/"
cp "${ROOT}/package.json" "${OUT_DIR}/resources/app/"
cp "${ROOT}/resources/default-config/"* "${OUT_DIR}/resources/app/" 2>/dev/null || true

# Install production dependencies in the packaged app
echo "Installing production deps..."
cd "${OUT_DIR}/resources/app"
cat > package.json << 'PKGEOF'
{
  "name": "freellm-hub",
  "version": "0.1.0",
  "main": "main/index.js",
  "dependencies": {
    "better-sqlite3": "^11.10.0",
    "fastify": "^5.2.0",
    "pino": "^9.5.0",
    "uuid": "^11.0.0",
    "zod": "^3.23.0"
  }
}
PKGEOF

npm install --omit=dev --ignore-scripts 2>/dev/null || true

# Copy native module manually
echo "Copying better-sqlite3 native module..."
mkdir -p "${OUT_DIR}/resources/app/node_modules"
cp -R "${ROOT}/node_modules/better-sqlite3" "${OUT_DIR}/resources/app/node_modules/" 2>/dev/null || true

echo ""
echo "=== Packaging complete ==="
echo "Output: ${OUT_DIR}"
echo "Run: '${OUT_DIR}/FreeLLM Hub.exe'"
