#!/bin/zsh
set -e
cd "$(dirname "$0")"

mkdir -p build

echo "[1/3] Compiling np.dylib (MediaRemote Now Playing reader)..."
clang -shared -fobjc-arc -framework Foundation -o build/np.dylib np.m

echo "[2/3] Compiling foldstage-audio-mac (Core Audio Process Tap)..."
swiftc -O -framework AppKit -framework CoreAudio -framework AudioToolbox -o build/foldstage-audio-mac audio-helper.swift

echo "[3/3] Packaging FoldStage Companion.app..."
APP="FoldStage Companion.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -framework Cocoa -framework WebKit -o "$APP/Contents/MacOS/FoldStageCompanion" app-shell.swift
cp build/foldstage-audio-mac "$APP/Contents/Resources/foldstage-audio-mac"
cp build/np.dylib "$APP/Contents/Resources/np.dylib"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>FoldStageCompanion</string>
  <key>CFBundleIdentifier</key><string>com.foldstage.companion</string>
  <key>CFBundleName</key><string>FoldStage Companion</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.2</string>
  <key>NSAudioCaptureUsageDescription</key><string>FoldStage captures audio from your selected music player to drive real-time Live2D beat synchronization.</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
ls -lh build/foldstage-audio-mac build/np.dylib "$APP/Contents/MacOS/FoldStageCompanion"
