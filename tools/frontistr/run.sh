#!/bin/sh
# Solve a case directory with FrontISTR: run.sh <dir> [fistr1 path]
set -e
d=${1:?case directory}
f=${2:-${FISTR1:-$HOME/.local/bin/fistr1}}
cd "$d"
"$f" > fistr.log 2>&1 || { tail -20 fistr.log; exit 1; }
grep -E 'solve \(sec\)|Completed' fistr.log | tail -2
