#!/usr/bin/env bash
# E2E (interactive TUI): parent pi runs under tmux so the process stays alive;
# the completion notice must (a) wake the parent as a follow-up turn and
# (b) be persisted in the session JSONL with display:true + details.
set -uo pipefail

export HERDR_SOCKET_PATH="${HERDR_SOCKET_PATH:-/tmp/notify-test.sock}"
export HERDR_CONFIG_PATH=/root/.config/herdr/config.toml
export HERDR_ENV=1
export MOCK_LLM_LOG=/root/work/mock-llm.log

mkdir -p /root/work /root/.config/herdr
: > /root/work/mock-llm.log

echo "### 0. binaries"
command -v pi herdr node tmux
pi --version; herdr --version

cd /root/work
if [ ! -d .git ]; then
  git init -q && git config user.email t@t && git config user.name t
  echo x > README && git add README && git commit -qm init
fi

echo "### 1. mock LLM"
node /opt/notify/mock-subagent-llm.mjs >/tmp/mock-llm.stdout 2>/tmp/mock-llm.stderr &
MOCK_PID=$!
for _ in $(seq 1 25); do
  node -e 'fetch("http://127.0.0.1:8765/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' && break
  sleep 0.2
done

echo "### 2. herdr server"
(herdr server >/tmp/herdr-server.log 2>&1 &)
up=0
for _ in $(seq 1 20); do
  herdr status server 2>/dev/null | grep -q "status: running" && { up=1; break; }
  sleep 0.5
done
[ "$up" = 1 ] || { echo "FAIL herdr server"; tail -20 /tmp/herdr-server.log; exit 1; }

WS_JSON=$(herdr workspace create --cwd /root/work --label notify-e2e --no-focus 2>/dev/null || true)
WS_ID=$(echo "$WS_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["workspace"]["workspace_id"])' 2>/dev/null || true)
echo "workspace: ${WS_ID:-<none>}"
[ -n "${WS_ID:-}" ] && export HERDR_WORKSPACE_ID="$WS_ID"

echo "### 3. parent pi under tmux (interactive, real TTY)"
rm -rf /root/.pi/agent/sessions
tmux kill-server 2>/dev/null || true
tmux new-session -d -s pi -x 120 -y 40 "cd /root/work && pi --thinking off --offline --provider mock --model flash --no-builtin-tools --tools subagent"
sleep 6
tmux capture-pane -t pi -p | tail -15 > /tmp/tui-boot.txt
echo "----- boot -----"; cat /tmp/tui-boot.txt

tmux send-keys -t pi "Launch a scout subagent for the task. Do not run herdr yourself." Enter
sleep 8
tmux capture-pane -t pi -p > /tmp/tui-after-launch.txt
echo "----- after launch -----"
grep -E "scout|pane|agents running|subagent" /tmp/tui-after-launch.txt | head -10 || true

# Wait for the completion notice to wake the parent (follow-up turn).
echo "### 4. waiting for wake-up..."
WAKE=0
for _ in $(seq 1 40); do
  if grep -q "notify_seen" /root/work/mock-llm.log 2>/dev/null; then WAKE=1; break; fi
  sleep 1
done
sleep 3
tmux capture-pane -t pi -p > /tmp/tui-final.txt
echo "----- final pane (grep) -----"
grep -aE "Background task|✓|NOTICE|wake|scout report" /tmp/tui-final.txt | head -10 || true

echo "### 5. verify persisted subagent-notify entry"
SESSION_FILE=$(find /root/.pi/agent/sessions -name "*.jsonl" 2>/dev/null | head -1 || true)
echo "session_file=${SESSION_FILE:-<none>}"
[ -z "${SESSION_FILE:-}" ] && { echo "RESULT: FAIL no session file"; kill $MOCK_PID 2>/dev/null; exit 1; }

python3 - "$SESSION_FILE" <<'PY'
import json, sys
path = sys.argv[1]
entries = []
for line in open(path):
    try: o = json.loads(line)
    except Exception: continue
    entries.append(o)
notices = [e for e in entries if e.get("type") == "custom_message" and e.get("customType") == "subagent-notify"]
print(f"notify_entries={len(notices)}")
if not notices:
    print("RESULT: FAIL — no subagent-notify entry persisted"); sys.exit(1)
ok = True
for n in notices:
    d = n.get("details") or {}
    head = (n.get("content") or "").splitlines()[0] if n.get("content") else ""
    print(f"  display={n.get('display')} head={head!r}")
    print(f"  details: status={d.get('status')} name={d.get('name')} exec={d.get('execution')}")
    if n.get("display") is not True: ok = False; print("  !! display not true")
    if not isinstance(d.get("name"), str): ok = False; print("  !! details.name missing")
    if "completed" not in (n.get("content") or ""): ok = False; print("  !! content lacks completion")
# Wake: an assistant message must follow the first notice (the follow-up turn ran).
idx = entries.index(notices[0])
followed = any(
    e.get("type") == "message" and e.get("message", {}).get("role") == "assistant"
    for e in entries[idx+1:]
)
if followed:
    print("  wake: assistant turn followed the notice")
else:
    ok = False; print("  !! no assistant turn after the notice — parent not woken")
print("PERSIST:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY
PERSIST=$?

echo "### 6. wake verdict"
if [ "$PERSIST" = 0 ]; then
  if python3 - "$SESSION_FILE" <<'PY'
import json, sys
entries = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
notices = [e for e in entries if e.get('type')=='custom_message' and e.get('customType')=='subagent-notify']
sys.exit(0 if notices and any(e.get('type')=='message' and e.get('message',{}).get('role')=='assistant' for e in entries[entries.index(notices[0])+1:]) else 1)
PY
  then WAKE=1; else WAKE=0; fi
else
  WAKE=0
fi
if [ "$WAKE" = 1 ]; then echo "WAKE: PASS"; else echo "WAKE: FAIL — parent never received the notice"; fi

kill $MOCK_PID 2>/dev/null
tmux kill-server 2>/dev/null || true
TOTAL=0
[ $PERSIST = 0 ] || TOTAL=1
[ $WAKE = 1 ] || TOTAL=1
echo "===== RESULT: $([ $TOTAL = 0 ] && echo PASS || echo FAIL) ====="
exit $TOTAL
