/**
 * Live RPC smoke coverage against the installed Pi CLI and a real provider.
 * Skips when the `pi` executable is not available on PATH.
 */

import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { RpcSupervisor } from "../../src/supervisor/rpc-supervisor.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";

const packageEntry = fileURLToPath(
	import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const piCliPath = path.resolve(path.dirname(packageEntry), "bundle/cli.js");
const piProbe = spawnSync("pi", ["--version"], {
	encoding: "utf8",
	timeout: 10_000,
});
// SAFETY: `spawnSync` errors are NodeJS.ErrnoException instances on ENOENT;
// the Node error may also be EACCES/timeout, which is intentionally fatal below.
const piProbeError = piProbe.error as NodeJS.ErrnoException | undefined;
function piInstallationSkipReason(input: {
	error?: NodeJS.ErrnoException;
	status: number | null;
	cliExists: boolean;
}): string | undefined {
	if (input.error?.code === "ENOENT") {
		return "pi is not installed on PATH; install Pi to run the live RPC smoke test";
	}
	if (input.error) {
		throw new Error(`pi is on PATH but its version probe failed: ${input.error.message}`);
	}
	if (input.status !== 0) {
		throw new Error(
			`pi is on PATH but 'pi --version' failed: ${piProbe.stderr || piProbe.stdout}`,
		);
	}
	if (!input.cliExists) {
		throw new Error(
			`pi is on PATH but RpcClient's bundled CLI is missing: ${piCliPath}`,
		);
	}
	return undefined;
}
const piSkipReason = piInstallationSkipReason({
	...(piProbeError ? { error: piProbeError } : {}),
	status: piProbe.status,
	cliExists: existsSync(piCliPath),
});
const agentDir = getAgentDir();
const providerExtensionPath = path.join(
	agentDir,
	"npm",
	"node_modules",
	"pi-any-endpoint",
	"extensions",
	"index.ts",
);
const hasProviderCredentials = (() => {
	try {
		const credentials = JSON.parse(
			readFileSync(path.join(agentDir, "auth.json"), "utf8"),
		) as Record<string, { access?: unknown }>;
		return typeof credentials["any-endpoint"]?.access === "string";
	} catch {
		return false;
	}
})();
const skip = piSkipReason ??
	(!existsSync(providerExtensionPath) || !hasProviderCredentials
		? "no saved pi-any-endpoint extension credentials; configure a live provider to run the RPC smoke test"
		: false);
const liveModel = process.env.PI_LIVE_MODEL;

test("live availability only skips an absent pi binary", () => {
	const missingPi = Object.assign(new Error("not found"), { code: "ENOENT" });
	assert.match(
		piInstallationSkipReason({ error: missingPi, status: null, cliExists: false }) ?? "",
		/pi is not installed/,
	);
	assert.throws(
		() => piInstallationSkipReason({ status: 1, cliExists: true }),
		/pi is on PATH but 'pi --version' failed/,
	);
	assert.throws(
		() => piInstallationSkipReason({ status: 0, cliExists: false }),
		/RpcClient's bundled CLI is missing/,
	);
});

function isolateAgentSettings(runDir: string): string {
	const isolatedDir = path.join(runDir, "pi-agent");
	mkdirSync(isolatedDir, { recursive: true });
	const settingsFile = path.join(agentDir, "settings.json");
	const settings = (existsSync(settingsFile)
		? JSON.parse(readFileSync(settingsFile, "utf8"))
		: {}) as Record<string, unknown>;
	// Avoid loading the host's pi-legion extension a second time. The smoke
	// explicitly lists only the provider plugin and this child guard.
	delete settings.packages;
	writeFileSync(
		path.join(isolatedDir, "settings.json"),
		JSON.stringify(settings),
	);
	for (const file of ["auth.json", "models.json", "models-store.json"]) {
		const source = path.join(agentDir, file);
		if (existsSync(source)) copyFileSync(source, path.join(isolatedDir, file));
	}
	return isolatedDir;
}

function liveInput(root: string, isolatedAgentDir: string): SpawnInput {
	return {
		name: "rpc-live",
		task: "Reply with exactly RPC_LIVE_OK. Do not use any tools.",
		agent: {
			name: "scout",
			description: "Live RPC smoke child",
			kind: "pi",
			source: "user",
			filePath: "<live-test>",
			systemPrompt: "",
			systemPromptMode: "append",
			inheritProjectContext: true,
			inheritSkills: false,
			tools: [],
			extensions: [providerExtensionPath],
		},
		sessionFile: path.join(root, "rpc-live.jsonl"),
		tempDir: root,
		// Keep the CLI outside the repository so project-discovered extensions
		// cannot collide with the explicit child-guard extension.
		cwd: root,
		...(liveModel ? { model: liveModel } : {}),
		env: { PI_CODING_AGENT_DIR: isolatedAgentDir },
		cliPath: piCliPath,
	};
}

test("live: launch a real Pi RPC child, wait for agent_settled, and retire", {
	skip,
}, async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "legion-rpc-live-"));
	const sessionFile = path.join(runDir, "rpc-live.jsonl");
	const supervisor = new RpcSupervisor({
		retireTimeoutMs: 5_000,
		signalTimeoutMs: 1_000,
	});
	let childStarted = false;
	try {
		// Pi lazily creates a session on first write; an empty existing file
		// ensures `--session <exact path>` resumes this caller-owned location.
		writeFileSync(sessionFile, "", { mode: 0o600 });
		const isolatedAgentDir = isolateAgentSettings(runDir);
		const events: string[] = [];
		supervisor.onEvent("rpc-live", (event) => events.push(event.type));
		const handle = await supervisor.spawnChild(
			liveInput(runDir, isolatedAgentDir),
		);
		childStarted = true;
		assert.equal(handle.name, "rpc-live");
		assert.equal(handle.sessionFile, sessionFile);
		assert.ok(handle.pid, "RpcClient must launch a child Pi process");
		assert.equal(supervisor.isAlive(handle.name), true);

		const settled = await supervisor.waitSettled(handle.name, 240_000);
		assert.equal(
			settled.settled,
			true,
			`expected agent_settled, got ${JSON.stringify(settled)}`,
		);
		assert.equal(settled.abnormal, false);
		assert.ok(events.includes("agent_settled"));
		assert.equal(existsSync(sessionFile), true);

		await supervisor.retire(handle.name);
		assert.equal(supervisor.isAlive(handle.name), false);
	} finally {
		if (childStarted) await supervisor.retire("rpc-live").catch(() => {});
		rmSync(runDir, { recursive: true, force: true });
	}
});
