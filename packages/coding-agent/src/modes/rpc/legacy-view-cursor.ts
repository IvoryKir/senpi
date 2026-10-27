/**
 * A legacy view frozen at one cut and read one frame at a time by a peer's baseline barrier (R3.C6.4). The
 * reader retains no array of generated frames; `release` ends the read on every path and is idempotent.
 */
export interface LegacyViewCursor {
	/** True when the frozen view has no frame at all: an attach installs no barrier and releases it at once. */
	readonly empty: boolean;
	next(): Promise<string | undefined>;
	release(): void;
}

/** A cursor over `count` frames, each derived on demand from a frozen source the owner releases once. */
export class FrozenFramesCursor implements LegacyViewCursor {
	private index = 0;
	private released = false;
	private readonly count: number;
	private readonly frame: (index: number) => string;
	private readonly onRelease: () => void;

	constructor(count: number, frame: (index: number) => string, onRelease: () => void) {
		this.count = count;
		this.frame = frame;
		this.onRelease = onRelease;
	}

	get empty(): boolean {
		return this.count === 0;
	}

	async next(): Promise<string | undefined> {
		if (this.released || this.index >= this.count) return undefined;
		return this.frame(this.index++);
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		this.onRelease();
	}
}
