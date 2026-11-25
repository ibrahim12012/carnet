#!/bin/bash
# Builds Carnet for this Mac: dist/Carnet-<version>-mac-arm64.dmg on Apple Silicon, -mac-x64.dmg on Intel.
# Needs Node.js (nodejs.org) and Apple's command line tools (in Terminal: xcode-select --install). With cmake
# (brew install cmake), whisper is built too and put in the app, for transcription on the Mac.
# Run it in Terminal from the Carnet folder: bash build-mac.sh
# The GitHub build (.github/workflows/build.yml) runs this same script.
set -euo pipefail
cd "$(dirname "$0")"

ARCH=$(uname -m)
[ "$ARCH" = "x86_64" ] && ARCH=x64
WHISPER_VERSION=v1.9.5

npm install

# 1. whisper.cpp, for the transcription on the Mac. Optional: without it, Carnet uses Homebrew's
#    (brew install whisper-cpp).
mkdir -p build/mac-whisper
if [ ! -x build/mac-whisper/whisper-cli ]; then
  if command -v cmake >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
    W=$(mktemp -d)
    # Apple Silicon: on the graphics chip (Metal). Intel: on the processor only. macOS 11 and later, like Carnet:
    # without the BLAS of Accelerate, whose functions used by whisper need macOS 13.3.
    if [ "$ARCH" = "arm64" ]; then OPTS="-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON"; else OPTS="-DGGML_METAL=OFF"; fi
    if git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggml-org/whisper.cpp "$W/src" \
      && cmake -S "$W/src" -B "$W/build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 -DBUILD_SHARED_LIBS=OFF \
        -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_BLAS=OFF $OPTS \
      && cmake --build "$W/build" --config Release -j "$(sysctl -n hw.ncpu)" --target whisper-cli \
      && [ -f "$W/build/bin/whisper-cli" ]; then
      cp "$W/build/bin/whisper-cli" build/mac-whisper/
      # It must run on any Mac: only libraries of macOS itself, nothing from Homebrew.
      DEPS=$(otool -L build/mac-whisper/whisper-cli | tail -n +2)
      echo "$DEPS"
      if [[ "$DEPS" == */opt/homebrew/* || "$DEPS" == */usr/local/* ]]; then
        echo "whisper needs Homebrew libraries: left out of the app."
        rm -f build/mac-whisper/whisper-cli
      else
        echo "whisper $WHISPER_VERSION built."
      fi
    else
      echo "whisper could not be built: Carnet will use Homebrew's (brew install whisper-cpp)."
    fi
    rm -rf "$W"
  else
    echo "cmake not found: whisper is not included, Carnet will use Homebrew's (brew install whisper-cpp)."
  fi
fi

# 2. The app. electron-builder does not sign it: there is no Apple developer account.
export CSC_IDENTITY_AUTO_DISCOVERY=false
npx electron-builder --mac dir "--$ARCH" --publish never
if [ "$ARCH" = "arm64" ]; then APP=dist/mac-arm64/Carnet.app; else APP=dist/mac/Carnet.app; fi
[ -d "$APP" ] || APP=$(find dist -maxdepth 2 -name Carnet.app -type d -print -quit)
if [ -z "$APP" ] || [ ! -d "$APP" ]; then echo "Carnet.app not found in dist/"; exit 1; fi
echo "App: $APP"

# 3. Ad hoc signature, without which a Mac with Apple Silicon refuses to open the app: the programs Carnet runs
#    (FFmpeg, whisper) first, tried once, then the app with everything inside it.
FF="$APP/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg"
WH="$APP/Contents/Resources/whisper/whisper-cli"
for f in "$FF" "$WH"; do
  if [ -f "$f" ]; then
    chmod +x "$f"
    codesign --force --sign - "$f"
  fi
done
"$FF" -hide_banner -version | sed -n 1p
if [ -f "$WH" ] && ! "$WH" --help >/dev/null 2>&1; then
  echo "whisper does not run on this Mac: left out of the app (Carnet will use Homebrew's)."
  rm -rf "$APP/Contents/Resources/whisper"
fi
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

# 4. The disk image to share.
npx electron-builder --mac dmg "--$ARCH" --prepackaged "$APP" --publish never
ls -lh dist/*.dmg
