#!/bin/sh
cd -- "$(dirname -- "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
bundle="Launch Distributed Orchestrator.app"
if [ ! -x "$bundle/Contents/MacOS/OrchestratorLauncher" ] || [ scripts/launcher.swift -nt "$bundle/Contents/MacOS/OrchestratorLauncher" ] || [ scripts/build-launcher.py -nt "$bundle/Contents/MacOS/OrchestratorLauncher" ]; then
  python3 scripts/build-launcher.py || exit 1
fi
exec open "$bundle"
