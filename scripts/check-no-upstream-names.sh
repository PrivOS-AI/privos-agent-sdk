#!/usr/bin/env bash
# Fail when an upstream skawld identifier reappears in shipped code, skills or docs.
# CHANGELOG.md keeps release history, LICENSE keeps the upstream copyright notice,
# and README.md keeps exactly one provenance line ("originally forked from").
set -euo pipefail
cd "$(dirname "$0")/.."
hits="$(grep -rIn -i skawld src scripts skills examples README.md package.json \
  --exclude=check-no-upstream-names.sh | grep -v '^README.md:[0-9]*:(originally forked from' || true)"
if [ -n "$hits" ]; then
  echo "skawld identifiers found (use the PrivOS names, see CHANGELOG 0.5.0):" >&2
  echo "$hits" >&2
  exit 1
fi
echo "no skawld identifiers"
