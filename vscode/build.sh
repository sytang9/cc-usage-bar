#!/usr/bin/env bash
# build.sh -- rebuild vscode/claude-usage.vsix from this folder. Needs node/npx (fetches @vscode/vsce).
# Bump "version" in package.json first, so VS Code sees an update.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
npx -y @vscode/vsce package --allow-missing-repository --skip-license -o claude-usage.vsix
