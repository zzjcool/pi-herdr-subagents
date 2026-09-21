#!/usr/bin/env node
/**
 * Streaming OpenAI mock driving the full subagent lifecycle.
 *
 * Decisions are made on the LATEST user prompt (earlier turns may already
 * carry tool results and notices):
 *   "Launch a scout subagent ..."        -> parent calls subagent (happy path)
 *   "Launch another scout ... failure..."-> parent calls subagent (fail path)
 *   child session (frozen constraints)   -> answers directly; 500 if its task
 *                                            mentions "failure handling"
 *   anything after a notice arrived      -> acknowledges and stops
 */
import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.MOCK_LLM_PORT || 8765);
const LOG = process.env.MOCK_LLM_LOG || "/tmp/mock-llm.log";
const CHILD_ANSWER =
	process.env.MOCK_CHILD_ANSWER ??
	"scout report: three entry points, hub at src/api.ts";

function append(line) {
	fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
}

function chunk(delta, finish = null) {
	return {
		id: "mock-1",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

function sse(res, chunks) {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
}

function toolCall(id, args) {
	return [
		chunk({ role: "assistant", content: "" }),
		chunk({
			tool_calls: [
				{
					index: 0,
					id,
					type: "function",
					function: { name: "subagent", arguments: args },
				},
			],
		}),
		chunk({}, "tool_calls"),
	];
}

function text(res, content) {
	sse(res, [
		chunk({ role: "assistant", content: "" }),
		chunk({ content }),
		chunk({}, "stop"),
	]);
}

const server = http.createServer((req, res) => {
	if (req.method === "GET" && req.url === "/health") {
		res.writeHead(200);
		res.end("ok");
		return;
	}
	const body = [];
	req.on("data", (c) => body.push(c));
	req.on("end", () => {
		let payload = {};
		try {
			payload = JSON.parse(Buffer.concat(body).toString("utf8") || "{}");
		} catch {
			payload = {};
		}
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		append(`roles=${messages.map((m) => m?.role).join(",")}`);

		const messageText = (m) => {
			if (typeof m?.content === "string") return m.content;
			if (Array.isArray(m?.content))
				return m.content
					.filter((c) => c?.type === "text")
					.map((c) => c.text)
					.join(" ");
			return "";
		};

		// The extension stamps every child task with a frozen-constraints
		// appendix; that is the reliable child marker.
		const isChild = messages.some(
			(m) =>
				m?.role === "user" &&
				messageText(m).includes("Frozen child constraints"),
		);

		if (isChild) {
			// Failure-path child: break its LLM call so the parent sees a
			// `failed` execution status.
			if (messages.some((m) => messageText(m).includes("failure handling"))) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { message: "mock child failure" } }));
				return;
			}
			text(res, CHILD_ANSWER);
			return;
		}

		const lastUser = [...messages]
			.reverse()
			.find((m) => m?.role === "user");
		const lastUserText = lastUser ? messageText(lastUser) : "";
		// The parent's launch prompts arrive as the trailing user message with no
		// assistant answer yet. Once an assistant/tool exchange follows, the
		// trailing message is the tool result — do not relaunch on history.
		const isFreshUserTurn =
			messages.length > 0 && messages.at(-1)?.role === "user";
		const sawNotice = messages.some((m) =>
			messageText(m).includes("Background task"),
		);

		if (isFreshUserTurn && /Launch another scout|failure handling/.test(lastUserText)) {
			sse(
				res,
				toolCall(
					"call_fail",
					'{"agent":"scout","task":"probe failure handling and report the facts"}',
				),
			);
			return;
		}

		if (isFreshUserTurn && /Launch a scout/.test(lastUserText)) {
			sse(
				res,
				toolCall(
					"call_1",
					'{"agent":"scout","task":"scout the repo and report the facts"}',
				),
			);
			return;
		}

		if (sawNotice) {
			append("notice_acknowledged");
			text(
				res,
				"NOTICE_RECEIVED: the subagent completion notice woke me and I read it.",
			);
			return;
		}

		text(res, "waiting for the background child.");
	});
});

server.listen(PORT, "127.0.0.1", () => {
	process.stdout.write(`mock-subagent-llm listening on ${PORT}\n`);
});
