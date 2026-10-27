import { type CanonicalUnit, laneTransition } from "./compact-lane-transitions.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { CompactSessionState, type CompactSessionStateOptions } from "./compact-session-state.ts";
import type { FrozenCompactState } from "./compact-state-view.ts";

/**
 * The lane's compact current state for one epoch (S03b-3): folded inside the lane's own acceptance step at the
 * lane's sequence, accepting only that epoch's registry nonce (RULING-39). A rejected fold makes it unavailable for the
 * rest of the epoch (legacy delivery is unaffected), so a cut never holds a partial or silently stale state.
 */
export class CompactLaneCurrent {
	private state: CompactSessionState | undefined;
	private cleanup: Promise<void> = Promise.resolve();
	private readonly owners = new WeakMap<FrozenCompactState, CompactSessionState>();

	bootstrap(options: CompactSessionStateOptions & { readonly epoch: string }): void {
		this.retire();
		this.state = new CompactSessionState(options);
	}

	/** Never throws: building the transition from a worker frame's record is part of the fold that may fail. */
	fold(unit: CanonicalUnit, sequence: number): void {
		if (!this.state) return;
		try {
			const transition = laneTransition(unit);
			if (transition) this.state.accept(transition, sequence);
		} catch (cause) {
			this.fail(cause);
		}
	}

	freeze(): FrozenCompactState | undefined {
		const state = this.state;
		if (!state) return undefined;
		try {
			const cut = state.freeze();
			this.owners.set(cut, state);
			return cut;
		} catch (cause) {
			this.fail(cause);
			return undefined;
		}
	}

	release(cut: FrozenCompactState | undefined): void {
		if (cut) this.owners.get(cut)?.release(cut);
	}

	read(cut: FrozenCompactState | undefined) {
		const owner = cut && this.owners.get(cut);
		if (!cut) return Promise.reject(new CompactReadError("unavailable"));
		if (!owner) return Promise.reject(new CompactReadError("ownership"));
		return owner.read(cut);
	}

	retire(): void {
		const state = this.state;
		this.state = undefined;
		if (state) this.cleanup = Promise.all([this.cleanup, state.retire()]).then(() => {});
	}

	idle(): Promise<void> {
		return Promise.all([this.cleanup, this.state?.idle()]).then(() => {});
	}

	/** The epoch's compact component stops here: a fold failed, or a canonical record never reached this lane. */
	fail(cause: unknown): void {
		if (!this.state) return;
		const reason = cause instanceof Error && "reason" in cause ? String(cause.reason) : String(cause);
		process.stderr.write(`senpi rpc acceptance: compact current state unavailable: ${reason}\n`);
		this.retire();
	}
}
