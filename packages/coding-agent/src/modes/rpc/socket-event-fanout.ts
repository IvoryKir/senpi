import type { LegacyViewCursor } from "./legacy-view-cursor.ts";
import { BaselineBarrier } from "./socket-baseline-barrier.ts";
import { type DrainStallPeer, waitForDrainOrStall } from "./socket-drain-stall.ts";
import { SocketEventQueueOverflowError } from "./socket-event-queue-errors.ts";
import { type ResyncCut, type ResyncReason, SocketPeerRecovery } from "./socket-peer-recovery.ts";

export { SocketEventQueueOverflowError, SocketEventQueueStallError } from "./socket-event-queue-errors.ts";

type SocketSink = {
	writeRaw(chunk: string): void;
	waitForBackpressure(): Promise<void>;
};

type QueueEntry = {
	line: string;
	bytes: number;
	key?: string;
	/**
	 * The record with its cumulative snapshot fields blanked (delta kept). When a
	 * later record with the same key supersedes this one, the entry is rewritten to
	 * this line instead of being replaced, so a stalled reader never loses a delta.
	 */
	demotedLine?: string;
	onWritten?: () => void;
	reply: boolean;
};

/** A baseline in FIFO position: an attach's frozen view, or a shed's gap plus its recovery cut. */
type BarrierEntry = { readonly barrier: BaselineBarrier; readonly recovery: boolean };
type QueueItem = QueueEntry | BarrierEntry;

const isBarrier = (item: QueueItem): item is BarrierEntry => "barrier" in item;

// A handful of image tool results is several MiB of base64 each; four of them
// blew the previous 4 MiB cap in one burst on a healthy reader. Overflow is a
// fail-closed disconnect (the client must resync), so the cap has to be well
// above any single burst a normal session produces.
const DEFAULT_QUEUE_BYTES = 64 * 1024 * 1024;

// Backpressure budget, NOT a credit pacer. A session worker's output credit is
// returned when every destination has ACCEPTED the record into its bounded queue
// (session-event-writer.ts, waitForSessionBackpressure), so a peer's kernel drain
// is no longer on the worker's critical path and this budget is deliberately
// independent of SESSION_WORKER_LIMITS.controlMs (5 s). It used to be forced below
// that deadline, which made a client busy for 4 s with >= 16 KB pending (macOS unix
// stream buffers are 8 KB each way) indistinguishable from a dead one: it was cut
// and its sessions were released (#1774). Tens of seconds of no progress at all is
// the legacy client's liveness signal. A client advertising event_resync instead
// sheds its buffered events at this deadline and is cut only after a missed ping.
//
// The budget is loop-SERVED time. While the host's own loop is blocked nobody can
// drain anything, and on unblock the timers phase runs before the pending drain I/O,
// so a wall-clock deadline cut every live peer after a long host stall (#1905). The
// deadline therefore re-arms for whatever blocked time the loop-lag watchdog recorded
// inside its window, and only a window the loop fully served ends in a cut.
export const DEFAULT_STALL_MS = 30_000;

/** Independent FIFO actor for one socket. It never shares a drain promise with another sink. */
export class SocketEventSinkActor {
	private readonly queue: QueueItem[] = [];
	private queuedBytes = 0;
	private draining?: Promise<void>;
	private closed = false;
	private failure?: unknown;
	private recovery?: SocketPeerRecovery;
	private recoveryEnabled = false;
	private snapshot?: (reason: ResyncReason) => ResyncCut;
	private attempt?: BaselineBarrier;
	private readonly stopped = new AbortController();

	private readonly sink: SocketSink;
	private readonly onFailure: (cause: unknown) => void;
	private readonly maxQueueBytes: number;
	private readonly stallPeer: DrainStallPeer;

	constructor(
		sink: SocketSink,
		onFailure: (cause: unknown) => void,
		maxQueueBytes = DEFAULT_QUEUE_BYTES,
		stallMs = DEFAULT_STALL_MS,
	) {
		this.sink = sink;
		this.onFailure = onFailure;
		this.maxQueueBytes = maxQueueBytes;
		this.stallPeer = {
			sink,
			stallMs,
			stopped: this.stopped.signal,
			queuedBytes: () => this.queuedBytes,
			shedAndPing: () => {
				if (!this.recovery || !this.recoveryEnabled) return false;
				this.shed("stall");
				this.recovery.ping();
				return true;
			},
		};
	}

	enableRecovery(snapshot: (reason: ResyncReason) => ResyncCut): void {
		this.recoveryEnabled = true;
		this.snapshot = snapshot;
		this.recovery ??= new SocketPeerRecovery((line) => this.sink.writeRaw(line));
		this.recovery.acknowledge();
	}

	disableRecovery(): void {
		this.recoveryEnabled = false;
		if (!this.recovery?.pending) this.recovery = undefined;
	}

	/**
	 * A newly attached session's baseline, frozen by the caller: it takes this FIFO position, so every record
	 * enqueued after it follows it, and a stale attempt (`live` false) writes nothing. Never holds credit. A view
	 * with no frame installs nothing, so the next record goes in flight exactly as before the attach.
	 */
	installBaseline(cursor: LegacyViewCursor, live: () => boolean): void {
		if (this.closed || cursor.empty) {
			cursor.release();
			return;
		}
		this.queue.push({ barrier: new BaselineBarrier(cursor, live), recovery: false });
		void this.drain();
	}

	enqueue(line: string, key?: string, onWritten?: () => void, demotedLine?: string, reply = false): void {
		if (this.closed) return;
		const bytes = Buffer.byteLength(line);
		if (key !== undefined) {
			const existing = this.queue.find((entry) => !isBarrier(entry) && entry.key === key);
			if (existing && !isBarrier(existing)) {
				// Lossless supersession. The old behaviour replaced the queued line
				// outright, which threw away every delta a stalled reader had not yet
				// received (a desktop client assembles text from deltas). Keep the
				// superseded record - demoted to its delta-only form when the producer
				// supplied one - and let only the newest record carry the snapshot.
				if (existing.demotedLine !== undefined) {
					this.queuedBytes -= existing.bytes;
					existing.line = existing.demotedLine;
					existing.bytes = Buffer.byteLength(existing.line);
					this.queuedBytes += existing.bytes;
					existing.demotedLine = undefined;
				}
				existing.key = undefined;
			}
		}
		if (this.queuedBytes + bytes > this.maxQueueBytes) {
			if (this.recovery && this.recoveryEnabled) {
				// The cut frozen now covers this record; only a reply still needs its own place behind it.
				this.cut("overflow");
				if (reply && this.queuedBytes + bytes <= this.maxQueueBytes) {
					this.queue.push({ line, bytes, onWritten, reply });
					this.queuedBytes += bytes;
				} else {
					if (reply) this.recovery.loseReply();
					onWritten?.();
				}
				void this.drain();
				return;
			}
			const overflow = new SocketEventQueueOverflowError(
				this.queuedBytes,
				bytes,
				this.maxQueueBytes,
				line.slice(0, 120),
			);
			this.closed = true;
			this.dropQueue();
			try {
				this.sink.writeRaw(`${JSON.stringify({ type: "overflow", error: "overflow, resync required" })}\n`);
			} catch (cause) {
				this.onFailure(cause);
			}
			this.onFailure(overflow);
			return;
		}
		this.queue.push({ line, bytes, key, demotedLine, onWritten, reply });
		this.queuedBytes += bytes;
		void this.drain();
	}

	async flush(): Promise<void> {
		while (this.draining) await this.draining;
		if (this.failure !== undefined) throw this.failure;
	}

	/**
	 * Resolve once every record enqueued so far has been ACCEPTED into this queue.
	 *
	 * `enqueue` admits a record synchronously, or fails closed on byte overflow, so
	 * acceptance is already settled by the time a caller asks - and it never waits for
	 * the peer to drain. This is the session worker's credit point (#1774); use
	 * `flush()` where the queue must actually reach the transport (close, shutdown).
	 */
	waitForAcceptance(): Promise<void> {
		return Promise.resolve();
	}

	close(): void {
		this.closed = true;
		this.dropQueue();
		this.stopped.abort();
	}

	/** Ends every queued baseline and the one in flight, then empties the queue. */
	private dropQueue(): void {
		for (const item of this.queue) if (isBarrier(item)) item.barrier.cancel();
		this.attempt?.cancel();
		this.queue.length = 0;
		this.queuedBytes = 0;
	}

	/** The stall deadline's shed: one cut per pending recovery, never a re-cut while the peer stays idle. */
	private shed(reason: ResyncReason): void {
		if (!this.recovery?.pending) this.cut(reason);
	}

	/**
	 * Freeze the cut C now: keep the replies, release every record and baseline the cut covers, and queue the
	 * recovery barrier (gap, then C's frames) ahead of the post-C suffix. While a cut is already pending this
	 * supersedes it: the predecessor is released and its captured suffix, which overflowed, is covered by C.
	 */
	private cut(reason: ResyncReason): void {
		if (!this.recovery || !this.snapshot) return;
		const replies: QueueEntry[] = [];
		for (const item of this.queue) {
			if (isBarrier(item)) item.barrier.cancel();
			else if (item.reply) replies.push(item);
			else item.onWritten?.();
		}
		this.attempt?.cancel();
		this.queue.length = 0;
		for (const reply of replies) this.queue.push(reply);
		this.queuedBytes = replies.reduce((bytes, entry) => bytes + entry.bytes, 0);
		this.recovery.shed(reason);
		this.queue.push({ barrier: new BaselineBarrier(this.snapshot(reason), () => !this.closed), recovery: true });
	}

	private async write(line: string): Promise<void> {
		this.sink.writeRaw(line);
		await waitForDrainOrStall(this.stallPeer, Buffer.byteLength(line));
	}

	/** A recovery barrier first waits for the peer to drain again, then opens with the gap; both kinds then stream C. */
	private async deliver(entry: BarrierEntry): Promise<void> {
		this.attempt = entry.barrier;
		try {
			if (entry.recovery) {
				await waitForDrainOrStall(this.stallPeer, 0);
				if (this.closed || !entry.barrier.active || !this.recovery) return;
				const gap = this.recovery.takeGap();
				if (!this.recoveryEnabled) this.recovery = undefined;
				await this.write(gap);
			}
			await entry.barrier.deliver((line) => this.write(line));
		} finally {
			entry.barrier.end();
			if (this.attempt === entry.barrier) this.attempt = undefined;
		}
	}

	private drain(): Promise<void> {
		if (this.draining) return this.draining;
		this.draining = (async () => {
			try {
				while (!this.closed && this.queue.length > 0) {
					const entry = this.queue.shift();
					if (entry === undefined) break;
					if (isBarrier(entry)) {
						await this.deliver(entry);
						continue;
					}
					this.queuedBytes -= entry.bytes;
					await this.write(entry.line);
					entry.onWritten?.();
				}
			} catch (cause) {
				this.failure = cause;
				this.closed = true;
				this.dropQueue();
				this.onFailure(cause);
			}
		})().finally(() => {
			this.draining = undefined;
			// An enqueue that lands between the loop's exit and this reaction sees the
			// stale settled promise and starts nothing; reschedule for it here.
			if (!this.closed && this.queue.length > 0) void this.drain();
		});
		return this.draining;
	}
}
