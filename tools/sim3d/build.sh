#!/bin/sh
# Compile the 3D core (src/sim3d and the 2D modules it imports) to plain ESM
# under tools/sim3d/build so the node harnesses here can import it.
# The build itself is tools/build-esm.mjs (node only, the same on macOS and Linux);
# this is the name the harnesses and docs have always used for it.
set -e
cd "$(dirname "$0")/../.."
exec node tools/build-esm.mjs sim3d "$@"
