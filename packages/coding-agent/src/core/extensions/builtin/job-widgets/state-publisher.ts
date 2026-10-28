/**
 * Sends a session's `job_widget_state` at most once per {@link PUBLISH_INTERVAL_MS} and only when
 * what a client draws changed: `updatedAtMs` moves with every output line, so it does not count.
 * A burst inside the interval collapses into one trailing send of the newest state.
 */
import type { JobWidgetState } from "./view-types.ts";

export const PUBLISH_INTERVAL_MS = 1000;

function displayKey(state: JobWidgetState): string {
	return JSON.stringify(state.jobs.map(({ updatedAtMs: _updatedAtMs, ...shown }) => shown));
}

const EMPTY_KEY = "[]";

export class JobWidgetStatePublisher {
	readonly #send: (state: JobWidgetState) => void;
	#sentKey = EMPTY_KEY;
	#sentAt: number | undefined;
	#latest: JobWidgetState | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#disposed = false;

	constructor(send: (state: JobWidgetState) => void) {
		this.#send = send;
	}

	/** The newest state; sent now, at the end of the current interval, or not at all when unchanged. */
	offer(state: JobWidgetState): void {
		if (this.#disposed) return;
		this.#latest = state;
		if (this.#timer !== undefined) return;
		const wait = this.#sentAt === undefined ? 0 : this.#sentAt + PUBLISH_INTERVAL_MS - Date.now();
		if (wait <= 0) {
			this.#flush();
			return;
		}
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#flush();
		}, wait);
		this.#timer.unref?.();
	}

	/** Forgets what was sent, so the next offer goes out even if unchanged (a new listener needs it). */
	reset(): void {
		this.#sentKey = "";
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#flush(): void {
		const state = this.#latest;
		if (!state) return;
		const key = displayKey(state);
		if (key === this.#sentKey) return;
		this.#sentKey = key;
		this.#sentAt = Date.now();
		this.#send(state);
	}
}
