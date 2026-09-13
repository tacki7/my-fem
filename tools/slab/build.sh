#!/bin/sh
# Compile the 2D slab theories (src/sim/slab.ts, muinv.ts and what they import)
# to plain ESM so the node checks here can import them. The work is done by
# tools/build-esm.mjs (node only, so it also runs on Linux); this wrapper is
# kept for old commands.
#
#   tools/slab/build.sh            -> tools/slab/build (git 管理外)
#   tools/slab/build.sh <outdir>   -> 別の場所へ（修正前のコードを残して比べるとき）
exec node "$(dirname "$0")/../build-esm.mjs" slab "$@"
