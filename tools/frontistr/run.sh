#!/bin/sh
# Solve a case directory with FrontISTR: run.sh <dir> [fistr1 path]
#
# MallocPreScribble: fistr1 5.9 reads an allocated array before writing it somewhere in the
# contact code, and on macOS the fresh pages sometimes hold a NaN pattern - the same rolling
# case then fails at the first Newton iteration in one directory and runs in another. Filling
# every allocation with 0xAA first makes the read harmless and the run repeatable (the
# residual history matches the runs that happened to get clean pages).
set -e
d=${1:?case directory}
f=${2:-${FISTR1:-$HOME/.local/bin/fistr1}}
cd "$d"
MallocPreScribble=1 "$f" > fistr.log 2>&1 || { tail -20 fistr.log; exit 1; }
grep -E 'solve \(sec\)|Completed' fistr.log | tail -2
