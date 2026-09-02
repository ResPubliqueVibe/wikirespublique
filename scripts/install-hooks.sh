#!/bin/sh
# Ставит post-merge в .git/hooks основного дерева (хуки в git не версионируются).
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COMMON=$(git -C "$ROOT" rev-parse --git-common-dir)
case $COMMON in /*) ;; *) COMMON=$(CDPATH= cd -- "$ROOT/$COMMON" && pwd) ;; esac

mkdir -p "$COMMON/hooks"
cp "$ROOT/scripts/post-merge" "$COMMON/hooks/post-merge"
chmod +x "$COMMON/hooks/post-merge"
echo "хук установлен: $COMMON/hooks/post-merge"
