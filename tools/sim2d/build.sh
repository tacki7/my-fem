#!/bin/sh
# Compile the 2D core (src/sim) to plain ESM so the node checks here can run a
# RollingSim without the browser. The work is done by tools/build-esm.mjs
# (node only, so it also runs on Linux); this wrapper is kept for old commands.
#
#   tools/sim2d/build.sh            -> tools/sim2d/build (git 管理外)
#   tools/sim2d/build.sh <outdir>   -> 別の場所へ
exec node "$(dirname "$0")/../build-esm.mjs" sim2d "$@"
