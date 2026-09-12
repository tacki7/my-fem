#!/bin/zsh
# Compile the 3D core (src/sim3d and the 2D modules it imports) to plain ESM
# under tools/sim3d/build so the node harnesses here can import it.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT" && npx tsc --outDir "$HERE/build" --rootDir src --module es2022 --moduleResolution bundler --target es2022 --noEmit false src/sim3d/*.ts
cd "$HERE/build" && for f in sim3d/*.js sim/*.js; do sed -i '' -E "s#from '(\.\.?/[a-z0-9/]+)'#from '\1.js'#g" "$f"; done
for f in sim3d/*.js; do ln -sf "$f" "$(basename "$f")"; done
