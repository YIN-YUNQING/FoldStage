#!/usr/bin/env bash
# Builds standalone FoldStage Android APK (com.foldstage.app).
# Works with standard ANDROID_HOME / ANDROID_SDK_ROOT (CI & developers)
# and also detects local toolchains when ANDROID_HOME is not set.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# 1. Ensure web runtime dependencies exist
if [ ! -f "$ROOT_DIR/web/vendor/three.module.min.js" ] || [ ! -f "$ROOT_DIR/web/vendor/mediapipe/face_landmarker.task" ]; then
  echo "[FoldStage] Fetching web & offline MediaPipe dependencies..."
  node "$ROOT_DIR/scripts/fetch-deps.mjs"
fi

# 2. Locate Android build tools (ANDROID_HOME first, then local fallback)
ANDROID_SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
AAPT2=""
D8_CMD=""
APKSIGNER=""
ANDROID_JAR=""
JAVA_BIN="${JAVA_HOME:+$JAVA_HOME/bin/}"

if [ -n "$ANDROID_SDK" ] && [ -d "$ANDROID_SDK/build-tools" ]; then
  BT_DIR="$(ls -1d "$ANDROID_SDK/build-tools"/* | sort -V | tail -n 1)"
  PF_DIR="$(ls -1d "$ANDROID_SDK/platforms"/android-* | sort -V | tail -n 1)"
  AAPT2="$BT_DIR/aapt2"
  D8_CMD="$BT_DIR/d8"
  APKSIGNER="$BT_DIR/apksigner"
  ANDROID_JAR="$PF_DIR/android.jar"
elif [ -d "$HOME/Library/Android/sdk/build-tools" ]; then
  BT_DIR="$(ls -1d "$HOME/Library/Android/sdk/build-tools"/* | sort -V | tail -n 1)"
  PF_DIR="$(ls -1d "$HOME/Library/Android/sdk/platforms"/android-* | sort -V | tail -n 1)"
  AAPT2="$BT_DIR/aapt2"
  D8_CMD="$BT_DIR/d8"
  APKSIGNER="$BT_DIR/apksigner"
  ANDROID_JAR="$PF_DIR/android.jar"
elif [ -n "${FOLDSTAGE_ANDROID_TOOLS_DIR:-}" ] && [ -d "$FOLDSTAGE_ANDROID_TOOLS_DIR" ]; then
  T="$FOLDSTAGE_ANDROID_TOOLS_DIR"
  AAPT2="$T/a/aapt2"
  ANDROID_JAR="$T/android-all.jar"
  LOCAL_R8_JAR="$T/r8.jar"
  LOCAL_SIGNER_CP="$T/apksig.jar:$T/signer.jar"
else
  echo "ERROR: Android SDK not found. Set ANDROID_HOME (with build-tools and platforms/android-34)." >&2
  exit 1
fi

JAVAC="${JAVA_BIN}javac"
JAVA="${JAVA_BIN}java"
KEYTOOL="${JAVA_BIN}keytool"

# 3. Generate an independent local debug keystore (never committed to git)
KS="$SCRIPT_DIR/keystore/debug.keystore"
mkdir -p "$SCRIPT_DIR/keystore"
if [ ! -f "$KS" ]; then
  echo "[FoldStage] Generating independent debug keystore..."
  "$KEYTOOL" -genkeypair -v -keystore "$KS" -storepass foldstage -keypass foldstage \
    -alias foldstage -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=FoldStage, OU=Dev, O=FoldStage, L=Local, S=Local, C=US" >/dev/null 2>&1
fi

# 4. Stage web assets into android/src/assets/web/
rm -rf out src/assets
mkdir -p out/classes out/res out/gen src/assets/web
cp -R "$ROOT_DIR/web/index.html" src/assets/web/
cp -R "$ROOT_DIR/web/vendor" src/assets/web/

echo "[1/5] Compiling resources..."
"$AAPT2" compile --dir src/res -o out/res/res.zip

echo "[2/5] Linking APK with bundled offline assets..."
"$AAPT2" link -I "$ANDROID_JAR" \
  --manifest src/AndroidManifest.xml \
  -A src/assets \
  --java out/gen \
  --min-sdk-version 26 --target-sdk-version 34 \
  -o out/base.apk out/res/res.zip

echo "[3/5] Compiling Java sources..."
"$JAVAC" -nowarn --release 11 -cp "$ANDROID_JAR" -d out/classes \
  out/gen/com/foldstage/app/R.java \
  src/java/com/foldstage/app/LocalServer.java \
  src/java/com/foldstage/app/MainActivity.java

echo "[4/5] Dexing with D8..."
CLASS_FILES=($(find out/classes -name '*.class'))
if [ -n "${D8_CMD:-}" ]; then
  "$D8_CMD" --release --min-api 26 --lib "$ANDROID_JAR" --output out "${CLASS_FILES[@]}"
else
  "$JAVA" -cp "$LOCAL_R8_JAR" com.android.tools.r8.D8 --release --min-api 26 --lib "$ANDROID_JAR" --output out "${CLASS_FILES[@]}"
fi

(cd out && zip -q -j base.apk classes.dex)

echo "[5/5] Signing APK..."
if [ -n "${APKSIGNER:-}" ]; then
  "$APKSIGNER" sign --ks "$KS" --ks-key-alias foldstage --ks-pass pass:foldstage --key-pass pass:foldstage --out out/foldstage.apk out/base.apk
else
  "$JAVA" -cp "$LOCAL_SIGNER_CP" Sign out/base.apk out/foldstage.apk "$KS" foldstage foldstage
fi

ls -lh out/foldstage.apk
