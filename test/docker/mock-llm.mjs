#!/usr/bin/env node
/**
 * Streaming OpenAI mock. Env:
 *   MOCK_TOOL_NAME  default bash
 *   MOCK_TOOL_ARGS  JSON object string for the first tool call
 */
import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.MOCK_LLM_PORT || 8765);
const LOG = process.env.MOCK_LLM_LOG || "/tmp/mock-llm.log";
const TOOL_NAME = process.env.MOCK_TOOL_NAME || "bash";
const TOOL_ARGS = process.env.MOCK_TOOL_ARGS || '{"command":"herdr agent prompt orchestrator hi"}';

function append(line) {
	fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
}

function sse(res, chunks) {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
}

function chunk(delta, finish = null) {
	return {
		id: "mock-1",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
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
		const hasToolResult = messages.some((m) => m?.role === "tool");
		const lastTool = [...messages].reverse().find((m) => m?.role === "tool");
		append(JSON.stringify({ hasToolResult, lastRole: messages.at(-1)?.role }));
		if (hasToolResult) {
			const text =
				typeof lastTool?.content === "string"
					? lastTool.content
					: "tool finished";
			sse(res, [
				chunk({ role: "assistant", content: "" }),
				chunk({ content: text.slice(0, 2000) }),
				chunk({}, "stop"),
			]);
			return;
		}
		sse(res, [
			chunk({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: TOOL_NAME, arguments: "" },
					},
				],
			}),
			chunk({
				tool_calls: [{ index: 0, function: { arguments: TOOL_ARGS } }],
			}),
			chunk({}, "tool_calls"),
		]);
	});
});

server.listen(PORT, "127.0.0.1", () => {
	append(`listening ${PORT} tool=${TOOL_NAME}`);
	process.stdout.write(`mock-llm listening on ${PORT}\n`);
});
