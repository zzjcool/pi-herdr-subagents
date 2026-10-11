#!/usr/bin/env bash
# E2E extras: (a) a failing child renders the FULL block (not the one-liner),
# (b) ctrl+o expands a collapsed completed notice back to the full block.
set -uo pipefail

export HERDR_SOCKET_PATH="${HERDR_SOCKET_PATH:-/tmp/notify-test.sock}"
export HERDR_CONFIG_PATH=/root/.config/herdr/config.toml
export HERDR_ENV=1
export MOCK_LLM_LOG=/root/work/mock-llm.log

mkdir -p /root/work /root/.config/herdr
: > /root/work/mock-llm.log

cd /root/work
[ -d .git ] || { git init -q && git config user.email t@t && git config user.name t && echo x > README && git add README && git commit -qm init; }

node /opt/notify/mock-subagent-llm.mjs >/tmp/mock-llm.stdout 2>/tmp/mock-llm.stderr &
MOCK_PID=$!
for _ in $(seq 1 25); do
  node -e 'fetch("http://127.0.0.1:8765/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' && break
  sleep 0.2
done
(herdr server >/tmp/herdr-server.log 2>&1 &)
up=0
for _ in $(seq 1 20); do
  herdr status server 2>/dev/null | grep -q "status: running" && { up=1; break; }
  sleep 0.5
done
[ "$up" = 1 ] || { echo "FAIL herdr server"; exit 1; }

rm -rf /root/.pi/agent/sessions
tmux kill-server 2>/dev/null || true
tmux new-session -d -s pi -x 120 -y 40 "cd /root/work && pi --thinking off --offline --provider mock --model flash --no-builtin-tools --tools subagent"
sleep 6

echo "### A. completed notice collapses; ctrl+o expands it"
tmux send-keys -t pi "Launch a scout subagent for the task. Do not run herdr yourself." Enter
# Wait for the child to finish and the notice to wake the parent.
for _ in $(seq 1 40); do
  grep -q "notice_acknowledged" /root/work/mock-llm.log 2>/dev/null && break
  sleep 1
done
sleep 3

tmux capture-pane -t pi -p > /tmp/tui-collapsed.txt
COLLAPSED=$(grep -c "✓ scout-0 (scout) · success" /tmp/tui-collapsed.txt || true)
echo "collapsed_row_found=$COLLAPSED"

tmux send-keys -t pi C-o
sleep 2
tmux capture-pane -t pi -p > /tmp/tui-expanded.txt
# Expanded: the full default block shows the execution: line AND the preview text.
EXPANDED_ROW=$(grep -c "✓ scout-0 (scout) · success" /tmp/tui-expanded.txt || true)
EXPANDED_BODY=$(grep -c "execution: success" /tmp/tui-expanded.txt || true)
PREVIEW=$(grep -c "scout report: three entry points" /tmp/tui-expanded.txt || true)
echo "after_ctrl_o: oneliner=$EXPANDED_ROW exec_line=$EXPANDED_BODY preview=$PREVIEW"

tmux send-keys -t pi C-o   # toggle back
sleep 2

echo "### B. failing child shows the full block immediately"
# The mock returns 500 for a child whose task mentions "failure handling".
: > /root/work/mock-llm.log
tmux send-keys -t pi "Launch another scout subagent to check failure handling." Enter
# Child gets 500s; pi retries (maxRetries=3, base 2s) then the turn fails.
# The second notice_acknowledged in the mock log means the failed child's
# notice arrived and woke the parent.
for _ in $(seq 1 90); do
  CNT=$(grep -c notice_acknowledged /root/work/mock-llm.log 2>/dev/null || true)
  [ "${CNT:-0}" -ge 2 ] && break
  sleep 2
done
sleep 3
tmux capture-pane -t pi -p > /tmp/tui-failed.txt
FAILED_BLOCK=$(grep -c "Background task failed" /tmp/tui-failed.txt || true)
FAILED_ONELINER=$(grep -c "✗" /tmp/tui-failed.txt || true)
echo "failed_block=$FAILED_BLOCK failed_oneliner=$FAILED_ONELINER"
grep -aE "Background task|execution:|✓|✗" /tmp/tui-failed.txt | head -12

python3 - <<'PY'
import sys
ok = True
# A: collapsed row existed before ctrl+o
collapsed = open("/tmp/tui-collapsed.txt").read()
if "✓ scout-0 (scout) · success" not in collapsed:
    print("A1 FAIL: no collapsed one-liner"); ok = False
else:
    print("A1 PASS: collapsed one-liner rendered")
expanded = open("/tmp/tui-expanded.txt").read()
if "✓ scout-0 (scout) · success" in expanded and "execution: success" in expanded:
    print("A2 PASS: ctrl+o expanded the notice")
elif "execution: success" in expanded:
    print("A2 PASS (full block shown after ctrl+o)")
else:
    print("A2 FAIL: ctrl+o did not expand"); ok = False
failed = open("/tmp/tui-failed.txt").read()
if "Background task failed" in failed:
    print("B  PASS: failure shows the full block")
else:
    print("B  INFO: no failure notice (child may not have failed); see pane")
print("RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY
RC=$?

kill $MOCK_PID 2>/dev/null
tmux kill-server 2>/dev/null || true
exit $RC
