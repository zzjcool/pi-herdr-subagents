/**
 * Command runner: spawns the `herdr` binary and captures stdout/stderr.
 *
 * Measured constraint (F21): herdr prints SUCCESS payloads on stdout but
 * ERROR payloads on STDERR. Both must be parsed, or errors look like
 * empty responses.
 */

import { spawn } from "node:child_process";
import type { CommandRunner } from "../shared/types.ts";

export const HERDR_BIN_ENV = "HERDR_BIN";
export const HERDR_BIN_PATH_ENV = "HERDR_BIN_PATH";

export function resolveHerdrBin(env: NodeJS.ProcessEnv = process.env): string {
	return env[HERDR_BIN_ENV] || env[HERDR_BIN_PATH_ENV] || "herdr";
}

export interface RunnerOptions {
	bin?: string;
	env?: NodeJS.ProcessEnv;
	/** Default timeout applied when a call does not specify one. */
	defaultTimeoutMs?: number;
}

/**
 * Create the default runner that shells out to herdr.
 * Errors are surfaced as a non-zero `code` plus whatever text was produced;
 * the caller (parseHerdrResponse) turns that into a structured HerdrError.
 */
export function createCommandRunner(
	options: RunnerOptions = {},
): CommandRunner {
	const bin = options.bin ?? resolveHerdrBin();
	const baseEnv = options.env ?? process.env;

	return (args, opts = {}) =>
		new Promise((resolve) => {
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(bin, args, {
					shell: false,
					windowsHide: true,
					env: { ...baseEnv, ...(opts.env ?? {}) },
				});
			} catch (cause) {
				resolve({ stdout: "", stderr: String(cause), code: -1 });
				return;
			}

			let stdout = "";
			let stderr = "";
			let settled = false;
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				resolve({ stdout, stderr, code });
			};

			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeoutMs = opts.timeoutMs ?? options.defaultTimeoutMs;
			if (timeoutMs && timeoutMs > 0) {
				timer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* already gone */
					}
					stderr += `\n[timeout after ${timeoutMs}ms]`;
					finish(-2);
				}, timeoutMs);
				timer.unref?.();
			}

			child.stdout?.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("error", (err) => {
				stderr += String(err);
				finish(-1);
			});
			child.on("close", (code) => finish(code ?? 0));
		});
}
