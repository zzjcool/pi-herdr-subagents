#!/usr/bin/env node
/**
 * Hermetic stand-in for the real `herdr` CLI, used by unit tests via
 * `HERDR_BIN`. It performs NO real work: it records every invocation to the
 * file named by `FAKE_HERDR_LOG` and answers with the minimum payloads the
 * launch path requires.
 *
 * Why this exists: a unit test must never spawn a real child process or touch
 * a real herdr workspace. Driving the registered tool through the real client
 * while pointing at this script keeps the argv-building and response-parsing
 * code under test without any side effects.
 *
 * Recorded lines are `<argv joined by spaces>` — enough to assert what model
 * and kind the launcher actually asked for.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const log = process.env.FAKE_HERDR_LOG;
if (log) {
	try {
		appendFileSync(log, `${argv.join(" ")}\n`);
	} catch {
		// Logging is best-effort; never fail the call because of it.
	}
}

const out = (value) => {
	process.stdout.write(`${JSON.stringify({ result: value })}\n`);
	process.exit(0);
};
const fail = (code, message) => {
	process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
	process.exit(1);
};

const [cmd, sub] = argv;

// `herdr --version` is the availability probe.
if (cmd === "--version") {
	process.stdout.write("herdr fake-0.0.0\n");
	process.exit(0);
}

if (cmd === "pane" && sub === "list") {
	out({ panes: [] });
}

if (cmd === "pane" && sub === "split") {
	out({
		pane: {
			pane_id: "w1:p1",
			tab_id: "w1:t1",
			workspace_id: "w1",
			cwd: null,
			agent_status: null,
		},
	});
}

if (cmd === "pane" && sub === "read") {
	// F6: plain text. Cursor/non-pi collect waits for a live reply on the pane
	// (jsonl is empty); an empty read would hang until turnTimeoutMs.
	process.stdout.write(
		'FAKE_PANE_REPLY from hermetic herdr\n{"ok": true, "reason": "fake herdr done"}\n',
	);
	process.exit(0);
}

if (cmd === "pane" && sub === "get") {
	out({
		pane: {
			pane_id: argv[2] ?? "w1:p1",
			tab_id: "w1:t1",
			workspace_id: "w1",
			cwd: null,
			agent_status: null,
		},
	});
}

if (cmd === "tab" && (sub === "list" || sub === "get")) {
	out(sub === "list" ? { tabs: [] } : { tab: { tab_id: "w1:t1", paneIds: [] } });
}

if (cmd === "tab" && sub === "create") {
	out({
		tab: { tab_id: "w1:t1", paneIds: ["w1:p1"] },
		root_pane: {
			pane_id: "w1:p1",
			tab_id: "w1:t1",
			workspace_id: "w1",
			cwd: null,
			agent_status: null,
		},
	});
}

if (cmd === "agent" && sub === "start") {
	// Return a pi-shaped session path (F1) so the launcher can proceed, and
	// write a COMPLETED turn there: the caller collects by reading this file,
	// so an empty one would leave the watcher polling until its timeout.
	const nameIdx = argv.indexOf("--name");
	const name = nameIdx >= 0 ? argv[nameIdx + 1] : "child";
	// Session files live beside the call log, NOT in a shared /tmp path, so the
	// test's own cleanup of its temp dir reclaims them (no cross-run residue).
	const base = log ? dirname(log) : "/tmp";
	const sessionPath = `${base}/sessions/${name}.jsonl`;
	try {
		mkdirSync(dirname(sessionPath), { recursive: true });
		writeFileSync(
			sessionPath,
			[
				JSON.stringify({ type: "session", id: `sess-${name}`, cwd: "fake" }),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: "task" },
				}),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						stopReason: "stop",
						model: "fake/model",
						usage: { input: 1, output: 1, cost: { total: 0 } },
					},
				}),
			].join("\n") + "\n",
		);
	} catch {
		// Best effort; a missing file surfaces as a collect timeout.
	}
	out({
		agent: {
			name,
			pane_id: "w1:p1",
			agent_status: "working",
			agent_session: {
				agent: "pi",
				kind: "path",
				source: "herdr:pi",
				value: sessionPath,
			},
		},
	});
}

if (cmd === "agent" && (sub === "prompt" || sub === "send-keys" || sub === "wait" || sub === "get")) {
	out({ ok: true, agent: { name: argv[2] ?? "child", agent_status: "idle" } });
}

if (cmd === "agent" && sub === "list") {
	out({ agents: [] });
}

// Anything else: succeed with an empty result rather than wedge the caller.
out({});
