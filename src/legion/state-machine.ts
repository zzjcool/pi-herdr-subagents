export const LEGION_PHASES = [
	"planning",
	"implementing",
	"reviewing",
	"verifying",
	"done",
	"failed",
	"aborted",
] as const;
export type LegionPhase = (typeof LEGION_PHASES)[number];

export const MAX_REWORK_COUNT = 2;
export const DEFAULT_PHASE_TIMEOUTS: Readonly<Record<LegionPhase, number>> = {
	planning: 15 * 60_000,
	implementing: 60 * 60_000,
	reviewing: 30 * 60_000,
	verifying: 15 * 60_000,
	done: 0,
	failed: 0,
	aborted: 0,
};

export type PhaseTransitionReason =
	| "invalid_phase"
	| "same_phase"
	| "terminal_phase"
	| "invalid_transition"
	| "contract_path_required"
	| "planner_still_active"
	| "worker_still_active"
	| "failed_worker_unhandled"
	| "all_workers_failed"
	| "reviewer_not_settled"
	| "review_verdict_not_accepted"
	| "review_verdict_not_rejected"
	| "verification_not_failed"
	| "verification_not_passed"
	| "rework_limit_exceeded"
	| "centurion_required"
	| "children_not_terminal"
	| "terminal_reason_required"
	| "all_children_not_failed";

export interface PhaseChild {
	id: string;
	role: string;
	status: string;
}

export interface EvaluatePhaseTransitionInput {
	from: LegionPhase | null;
	to: LegionPhase;
	reworkCount?: number;
	contractPath?: string | null;
	children?: readonly PhaseChild[];
	failedWorkerHandledIds?: readonly string[];
	reviewerVerdictOk?: boolean;
	verificationPassed?: boolean;
	actorRole?: string;
	terminalReason?: "parent_decision" | "all_children_failed" | "rework_exhausted" | "parent_retire";
}

export type PhaseTransitionDecision =
	| {
		allowed: true;
		from: LegionPhase | null;
		to: LegionPhase;
		reworkCount: number;
		phaseSince: number;
		notifyParent: boolean;
		event: { type: "phase_change"; data: Record<string, unknown> };
	}
	| {
		allowed: false;
		from: LegionPhase | null;
		to: LegionPhase;
		reason: PhaseTransitionReason;
		message: string;
		forcedTransition?: {
			to: "failed";
			reworkCount: number;
			reason: "rework_exhausted" | "all_children_failed";
		};
		alarm: true;
	};

/** Pure decision function for the §7.1 transition table and entry invariants. */
export function evaluatePhaseTransition(
	input: EvaluatePhaseTransitionInput,
	now: () => number = () => Date.now(),
): PhaseTransitionDecision {
	const { from, to } = input;
	const children = input.children ?? [];
	const reworkCount = input.reworkCount ?? 0;
	if (!isLegionPhase(to) || (from !== null && !isLegionPhase(from))) {
		return denied(input, "invalid_phase", "phase is not part of the legion state machine");
	}
	if (!Number.isInteger(reworkCount) || reworkCount < 0) {
		return denied(input, "invalid_phase", "reworkCount must be a non-negative integer");
	}
	if (from === to) return denied(input, "same_phase", "phase is already current");
	if (from !== null && isTerminalPhase(from)) {
		return denied(input, "terminal_phase", `terminal phase ${from} cannot transition`);
	}
	if (from === null && to !== "planning") {
		return denied(input, "invalid_transition", "a new team must start in planning");
	}
	if (to === "aborted") {
		if (input.terminalReason !== "parent_retire") {
			return denied(input, "terminal_reason_required", "aborted requires a parent retire decision");
		}
		return allowed(input, reworkCount, now(), false);
	}
	if (from === "implementing" || to === "implementing") {
		const planner = children.find((child) => child.role === "planner" && child.status === "running");
		if (planner) {
			return denied(input, "planner_still_active", `planner child ${planner.id} is still running during implementing`);
		}
	}
	if (to === "failed") return evaluateFailure(input, children, reworkCount, now);
	if (from === null) return allowed(input, reworkCount, now(), false);

	if (from === "planning" && to === "implementing") {
		if (!input.contractPath?.trim()) {
			return denied(input, "contract_path_required", "planning requires a non-empty contract_path");
		}
		return allowed(input, reworkCount, now(), false);
	}
	if (from === "implementing" && to === "reviewing") {
		const workers = children.filter((child) => child.role === "worker");
		if (workers.some((child) => isActiveChild(child.status))) {
			return denied(input, "worker_still_active", "all worker children must be settled before reviewing");
		}
		if (workers.length > 0 && workers.every((child) => child.status === "failed")) {
			return {
				...denied(input, "all_workers_failed", "all worker children failed; team must fail"),
				forcedTransition: { to: "failed", reworkCount, reason: "all_children_failed" },
			};
		}
		const handled = new Set(input.failedWorkerHandledIds ?? []);
		const unhandled = workers.find((child) => child.status === "failed" && !handled.has(child.id));
		if (unhandled) {
			return denied(input, "failed_worker_unhandled", `failed worker ${unhandled.id} must be reworked or transferred to failed`);
		}
		return allowed(input, reworkCount, now(), false);
	}
	if (from === "reviewing" && to === "verifying") {
		if (!children.some((child) => child.role === "reviewer" && child.status === "settled")) {
			return denied(input, "reviewer_not_settled", "at least one reviewer must be settled before verifying");
		}
		if (input.reviewerVerdictOk !== true) {
			return denied(input, "review_verdict_not_accepted", "reviewing requires a settled reviewer verdict ok:true");
		}
		return allowed(input, reworkCount, now(), false);
	}
	if (from === "reviewing" && to === "implementing") {
		if (input.reviewerVerdictOk !== false) {
			return denied(input, "review_verdict_not_rejected", "review rework requires reviewer verdict ok:false");
		}
		return evaluateRework(input, reworkCount, now);
	}
	if (from === "verifying" && to === "implementing") {
		if (input.verificationPassed !== false) {
			return denied(input, "verification_not_failed", "verification rework requires a failing verification result");
		}
		return evaluateRework(input, reworkCount, now);
	}
	if (from === "reviewing" && to === "planning") {
		if (input.actorRole !== "centurion") {
			return denied(input, "centurion_required", "only the centurion may return a bad plan to planning");
		}
		return allowed(input, reworkCount, now(), true);
	}
	if (from === "verifying" && to === "done") {
		if (input.verificationPassed !== true) {
			return denied(input, "verification_not_passed", "done requires all verification commands to pass");
		}
		if (children.some((child) => !isTerminalChild(child.status))) {
			return denied(input, "children_not_terminal", "DONE requires every child node to be terminal");
		}
		return allowed(input, reworkCount, now(), false);
	}
	return denied(input, "invalid_transition", `transition ${from} → ${to} is not allowed`);
}

export interface PhaseTimeoutInput {
	phase: LegionPhase;
	phaseSince: number | null;
	now?: number;
	timeouts?: Partial<Record<LegionPhase, number>>;
}

export interface PhaseTimeoutResult {
	phase: LegionPhase;
	timedOut: boolean;
	phaseSince: number | null;
	now: number;
	elapsedMs: number | null;
	timeoutMs: number;
}

/** Check an independent phase clock; timeout never kills work. */
export function checkPhaseTimeout(
	input: PhaseTimeoutInput,
	clock: () => number = () => Date.now(),
): PhaseTimeoutResult {
	if (!isLegionPhase(input.phase)) throw new TypeError(`invalid legion phase: ${String(input.phase)}`);
	const now = input.now ?? clock();
	if (!Number.isFinite(now)) throw new TypeError("now must be a finite millisecond timestamp");
	if (input.phaseSince !== null && !Number.isFinite(input.phaseSince)) {
		throw new TypeError("phaseSince must be null or a finite millisecond timestamp");
	}
	const timeoutMs = input.timeouts?.[input.phase] ?? DEFAULT_PHASE_TIMEOUTS[input.phase];
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new TypeError("phase timeout must be a finite non-negative duration");
	}
	const elapsedMs = input.phaseSince === null ? null : Math.max(0, now - input.phaseSince);
	return {
		phase: input.phase,
		timedOut: elapsedMs !== null && !isTerminalPhase(input.phase) && elapsedMs >= timeoutMs,
		phaseSince: input.phaseSince,
		now,
		elapsedMs,
		timeoutMs,
	};
}

export function isTerminalPhase(phase: LegionPhase): boolean {
	return phase === "done" || phase === "failed" || phase === "aborted";
}

export function isTerminalChild(status: string): boolean {
	return status === "settled" || status === "failed" || status === "retired";
}

export function isLegionPhase(value: unknown): value is LegionPhase {
	return typeof value === "string" && (LEGION_PHASES as readonly string[]).includes(value);
}

function evaluateRework(
	input: EvaluatePhaseTransitionInput,
	reworkCount: number,
	now: () => number,
): PhaseTransitionDecision {
	const next = reworkCount + 1;
	if (next > MAX_REWORK_COUNT) {
		return {
			...denied(input, "rework_limit_exceeded", `rework count ${next} exceeds limit ${MAX_REWORK_COUNT}`),
			forcedTransition: { to: "failed", reworkCount: next, reason: "rework_exhausted" },
		};
	}
	return allowed(input, next, now(), false);
}

function evaluateFailure(
	input: EvaluatePhaseTransitionInput,
	children: readonly PhaseChild[],
	reworkCount: number,
	now: () => number,
): PhaseTransitionDecision {
	if (input.terminalReason === "parent_decision") return allowed(input, reworkCount, now(), false);
	if (input.terminalReason === "rework_exhausted") {
		if (reworkCount <= MAX_REWORK_COUNT) {
			return denied(input, "rework_limit_exceeded", `rework_count must exceed ${MAX_REWORK_COUNT} for rework_exhausted`);
		}
		return allowed(input, reworkCount, now(), false);
	}
	if (input.terminalReason === "all_children_failed") {
		if (children.length === 0 || children.some((child) => child.status !== "failed")) {
			return denied(input, "all_children_not_failed", "all_children_failed requires every child to have failed");
		}
		return allowed(input, reworkCount, now(), false);
	}
	return denied(input, "terminal_reason_required", "failed requires parent decision, all children failed, or exhausted rework");
}

function allowed(
	input: EvaluatePhaseTransitionInput,
	reworkCount: number,
	phaseSince: number,
	notifyParent: boolean,
): PhaseTransitionDecision {
	if (!Number.isFinite(phaseSince)) throw new TypeError("phase clock must return a finite timestamp");
	return {
		allowed: true,
		from: input.from,
		to: input.to,
		reworkCount,
		phaseSince,
		notifyParent,
		event: {
			type: "phase_change",
			data: {
				from: input.from,
				to: input.to,
				reworkCount,
				...(notifyParent ? { notifyParent: true } : {}),
			},
		},
	};
}

function denied(
	input: Pick<EvaluatePhaseTransitionInput, "from" | "to">,
	reason: PhaseTransitionReason,
	message: string,
): Extract<PhaseTransitionDecision, { allowed: false }> {
	return { allowed: false, from: input.from, to: input.to, reason, message, alarm: true };
}

function isActiveChild(status: string): boolean {
	return status === "starting" || status === "running" || status === "blocked";
}
