#!/bin/bash
# Compare NAS speed through a mounted SMB share vs rclone's built-in SMB client.
# Usage: bench-nas.sh <rclone> <rclone.conf> <mounted dir> <remote:path> [listing-dir-mounted] [listing-dir-remote]
# Creates test files under <dir>/bench on both paths; remove them afterwards.
set -u
RC="$1"; CONF="$2"; MNT="$3"; REM="$4"; LM="${5:-}"; LR="${6:-}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/big" "$W/small"
mkfile 1g "$W/big/test-1g.bin" 2>/dev/null || head -c 1073741824 /dev/zero > "$W/big/test-1g.bin"
for i in $(seq 1 1000); do head -c 32768 /dev/urandom > "$W/small/f$i.dat"; done
FLAGS=(--transfers 16 --checkers 32)
now() { python3 -c 'import time;print(time.time())'; }
t() {
  local label=$1; shift
  local s; s=$(now)
  if ! "$@" >/dev/null 2>"$W/err"; then echo "  $label: FAILED - $(tail -1 "$W/err")"; return; fi
  python3 -c "print(f'  {\"$label\":<14} {$(now)-$s:7.1f} s')"
}
local_rc() { "$RC" "$@"; }
smb_rc() { "$RC" --config "$CONF" "$@"; }

echo "== upload 1 GB file"
t "Finder share" local_rc copy "$W/big" "$MNT/bench/mount-big" "${FLAGS[@]}"
t "rclone SMB"   smb_rc   copy "$W/big" "$REM/bench/smb-big" "${FLAGS[@]}"
echo "== upload 1,000 x 32 KB files"
t "Finder share" local_rc copy "$W/small" "$MNT/bench/mount-small" "${FLAGS[@]}"
t "rclone SMB"   smb_rc   copy "$W/small" "$REM/bench/smb-small" "${FLAGS[@]}"
if [ -n "$LM" ]; then
  echo "== list every file in the addon folder (what each sync check does)"
  t "Finder share" local_rc lsf -R --files-only "$LM"
  t "rclone SMB"   smb_rc   lsf -R --files-only "$LR"
fi
echo "== download 1 GB file"
t "Finder share" local_rc copy "$MNT/bench/mount-big" "$W/dl-m" "${FLAGS[@]}"
t "rclone SMB"   smb_rc   copy "$REM/bench/smb-big" "$W/dl-s" "${FLAGS[@]}"
