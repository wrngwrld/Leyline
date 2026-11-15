#!/bin/bash
# Two-machine test of the sync engine on copies of the real data.
# Usage: scenarios.sh <testdir> <remoteRoot>
#   <testdir> holds mac/, pc/, mac.json, pc.json (mac/ must already be seeded to the NAS)
set -u
T="$1"; R="$2"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CLI=(node "$HERE/engine/cli.mjs")
sync() { local m=$1; shift; local t0=$(date +%s.%N 2>/dev/null || python3 -c 'import time;print(time.time())'); "${CLI[@]}" sync "$T/$m.json" --quiet "$@" >"$T/last-$m.json" 2>"$T/last-$m.log"; local rc=$?; local t1=$(python3 -c 'import time;print(time.time())'); grep -E '^  [A-Za-z]+: ' "$T/last-$m.log" | sed "s/^/    [$m] /"; [ $rc -eq 0 ] || { echo "    [$m] SYNC FAILED rc=$rc"; tail -20 "$T/last-$m.log"; }; }
ok() { echo "  PASS: $*"; }; bad() { echo "  FAIL: $*"; FAILS=$((FAILS+1)); }
FAILS=0
ACC_REL=$(cd "$T/mac/Account" && find . -type f -name 'Questie.lua' | head -1)

echo "== S1 mac: nothing changed"
sync mac

echo "== S2 pc: first sync, already has the same files (like the PC today)"
rm -rf "$T/pc"; mkdir -p "$T/pc"; cp -c -R "$T/mac/." "$T/pc/"
sync pc

echo "== S3 play session on mac: 130 settings files change"
files=$(cd "$T/mac" && find Account SavedVariables -type f -name '*.lua' | head -130)
n=0; for f in $files; do printf '\n-- session edit %s\n' "$(date +%s)" >> "$T/mac/$f"; n=$((n+1)); done
echo "  edited $n files"
sync mac --only Account,SavedVariables
sync pc --only Account,SavedVariables
same=0; diff=0; for f in $files; do cmp -s "$T/mac/$f" "$T/pc/$f" && same=$((same+1)) || diff=$((diff+1)); done
[ $diff -eq 0 ] && ok "all $same edited files arrived on pc" || bad "$diff files differ on pc"

echo "== S4 conflict: same file edited on both, pc edited later"
echo '-- mac version' >> "$T/mac/Account/$ACC_REL"
sleep 3
echo '-- pc version' >> "$T/pc/Account/$ACC_REL"
sync mac --only Account
sync pc --only Account
sync mac --only Account
tail -1 "$T/mac/Account/$ACC_REL" | grep -q 'pc version' && ok "mac now has the newer pc version" || bad "mac has: $(tail -1 "$T/mac/Account/$ACC_REL")"
tail -1 "$T/pc/Account/$ACC_REL" | grep -q 'pc version' && ok "pc keeps its version" || bad "pc has: $(tail -1 "$T/pc/Account/$ACC_REL")"
loser=$(grep -rl -- '-- mac version' "$R/history" 2>/dev/null | head -1)
[ -n "$loser" ] && ok "mac's losing version kept in NAS history: ${loser#$R/}" || bad "mac's losing version not found in NAS history"
stray=$(find "$T/mac/Account" "$T/pc/Account" -name '*.conflict*' | wc -l | tr -d ' ')
[ "$stray" = 0 ] && ok "no .conflict files left in WTF" || bad "$stray .conflict files in WTF"

echo "== S5 addon installed on mac appears on pc"
small=$(cd "$T/mac/AddOns" && ls | grep -i HideAllUI | head -1)
cp -R "$T/mac/AddOns/$small" "$T/mac/AddOns/ZZ_TestAddon"
sync mac --only AddOns
sync pc --only AddOns
[ -d "$T/pc/AddOns/ZZ_TestAddon" ] && ok "ZZ_TestAddon installed on pc" || bad "ZZ_TestAddon missing on pc"

echo "== S6 addon removed on pc disappears on mac, kept in history"
rm -rf "$T/pc/AddOns/ZZ_TestAddon"
sync pc --only AddOns
sync mac --only AddOns
[ ! -d "$T/mac/AddOns/ZZ_TestAddon" ] && ok "ZZ_TestAddon removed on mac" || bad "ZZ_TestAddon still on mac"
find "$R/history" -path '*ZZ_TestAddon*' -type f | grep -q . && ok "removed addon kept in NAS history" || bad "removed addon not in history"
find "$T/mac/AddOns" -type d -empty -name 'ZZ_TestAddon' | grep -q . && bad "empty folder left on mac" || true

echo "== S7 in-use marker"
"${CLI[@]}" lock "$T/mac.json" --flavor _forever_ >/dev/null && ok "mac took the marker"
out=$("${CLI[@]}" lock "$T/pc.json" --flavor _forever_); rc=$?
[ $rc -eq 2 ] && ok "pc sees it is in use: $out" || bad "pc lock rc=$rc $out"
"${CLI[@]}" unlock "$T/mac.json" --flavor _forever_ >/dev/null && ok "mac released the marker"

echo "== S8 download speed: one voice-pack addon from NAS"
big=$(cd "$T/mac/AddOns" && du -sk * | sort -n | awk '$1>150000 && $1<200000{print $2; exit}')
rm -rf "$T/dl"; mkdir -p "$T/dl"
t0=$(python3 -c 'import time;print(time.time())')
"$HERE/vendor/rclone/darwin-arm64/rclone" copy "$R/current/_forever_/AddOns/$big" "$T/dl/$big" --transfers 16 --checkers 32 2>&1 | tail -2
t1=$(python3 -c 'import time;print(time.time())')
python3 - "$T/dl/$big" "$t0" "$t1" <<'EOF'
import os,sys
p,t0,t1=sys.argv[1],float(sys.argv[2]),float(sys.argv[3])
n=s=0
for d,_,fs in os.walk(p):
    for f in fs: n+=1; s+=os.path.getsize(os.path.join(d,f))
dt=t1-t0
print(f"  {os.path.basename(p)}: {n} files, {s/1048576:.0f} MB in {dt:.1f}s = {s/1048576/dt:.1f} MB/s, {n/dt:.0f} files/s")
EOF

echo; echo "== done, failures: $FAILS"
