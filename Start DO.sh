#!/bin/sh
# Start DO on Linux. The first start also adds DO to your apps menu, so after
# that it is one click from there. Run this once from your file manager or a terminal.
cd -- "$(dirname -- "$0")" || exit 1
node=$(command -v node) || node=$("${SHELL:-/bin/sh}" -ilc 'command -v node' 2>/dev/null | tail -n 1)
if [ -z "$node" ] || [ ! -x "$node" ]; then
  message='Install Node.js 22 or newer and Git, then start DO again.'
  command -v zenity >/dev/null 2>&1 && zenity --error --title=DO --text="$message" 2>/dev/null
  echo "$message" >&2
  exit 1
fi
export PATH="$(dirname -- "$node"):$PATH"
# With no desktop there is no window to close, so stay here: Ctrl-C stops DO.
[ -n "$DISPLAY$WAYLAND_DISPLAY" ] || exec "$node" scripts/launcher.mjs
exec "$node" scripts/launcher.mjs --detach
