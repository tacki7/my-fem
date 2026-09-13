#!/bin/zsh
# Compile the 2D core (src/sim) to plain ESM so the node checks here can run a
# RollingSim without the browser.
#
#   tools/sim2d/build.sh            -> tools/sim2d/build (git 管理外)
#   tools/sim2d/build.sh <outdir>   -> 別の場所へ
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=${1:-$HERE/build}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
cd "$ROOT" && npx tsc --outDir "$OUT" --rootDir src --module es2022 --moduleResolution bundler \
  --target es2022 --noEmit false --skipLibCheck src/sim/solver.ts src/sim/muinv.ts
cd "$OUT" && for f in sim/*.js; do sed -i '' -E "s#from '(\.\.?/[A-Za-z0-9/]+)'#from '\1.js'#g" "$f"; done
