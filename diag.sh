#!/bin/zsh
# CHROMA DIAGNOSTIC
# Run from the folder that is actually loaded as the unpacked extension.
#   zpx diag.sh          -> report only
#   zpx diag.sh bisect   -> temporarily swap in a minimal service worker

DIR="${1:-.}"
MF="$DIR/manifest.json"

print -r -- "=== files Chrome will read ==="
python3 - "$MF" <<'PY'
import json, os, sys, hashlib
mf = json.load(open(sys.argv[1]))
root = os.path.dirname(os.path.abspath(sys.argv[1]))
def show(kind, rel):
    p = os.path.join(root, rel)
    if os.path.exists(p):
        b = open(p,'rb').read()
        t = b.decode('utf-8', 'replace')
        print(f"  {kind:<10} {rel:<26} {len(b):>7} bytes  {len(t.splitlines()):>4} lines  sha256:{hashlib.sha256(b).hexdigest()[:12]}")
    else:
        print(f"  {kind:<10} {rel:<26} MISSING")
sw = mf.get('background',{}).get('service_worker')
show('sw', sw)
print(f"  sw mode: {'module' if mf.get('background',{}).get('type')=='module' else 'classic'}")
show('popup', mf.get('action',{}).get('default_popup',''))
for cs in mf.get('content_scripts',[]):
    for j in cs.get('js',[]):
        show('content', j)
PY

print -r -- ""
print -r -- "=== does background.js parse as a plain script? ==="
if command -v node >/dev/null; then
  node --check "$DIR/$(python3 -c "import json,sys;print(json.load(open('$MF'))['background']['service_worker'])")" \
    && print -r -- "  OK - parses as classic script" \
    || print -r -- "  FAIL"
else
  print -r -- "  (node not found, skipped)"
fi

print -r -- ""
print -r -- "=== load-time hazards in the service worker ==="
SW=$(python3 -c "import json;print(json.load(open('$MF'))['background']['service_worker'])")
grep -nE '(^|[^.#/[:alnum:]_$])(window|document|localStorage|sessionStorage)([^[:alnum:]_$]|$)' "$DIR/$SW" \
  | grep -v '^\s*[0-9]*:\s*//' | grep -vE ':\s*//' && print -r -- "  ^ hits above MUST be inside functions" \
  || print -r -- "  none"

if [ "$1" = "bisect" ]; then
  print -r -- ""
  print -r -- "=== BISECT: swapping in a trivial service worker ==="
  cp "$DIR/$SW" "$DIR/$SW.chromabackup"
  cat > "$DIR/$SW" <<'EOF'
console.log('chroma bisect: trivial worker running');
chrome.runtime.onMessage.addListener((m, s, r) => { r({ status: 'Ready' }); return false; });
EOF
  print -r -- "  backed up to $SW.chromabackup"
  print -r -- "  Reload the extension at chrome://extensions, then reopen the popup."
  print -r -- "  If the popup now works, the fault is in background.js."
  print -r -- "  Restore with:  mv $SW.chromabackup $SW"
fi
