import type { LeafId } from "./compact-content-store.ts";
import { CompactSpoolStorage } from "./compact-spool-storage.ts";
import type { CompactStorageOperation } from "./compact-storage-io.ts";

/** Where a committed leaf's bytes are; a rewrite moves the slot while the leaf stays committed. */
export interface CompactSlot {
	segment: CompactSegment;
	offset: number;
	readonly bytes: number;
}

/** One flush batch in one spool file, with the leaves still live in it. */
export interface CompactSegment {
	readonly path: string;
	readonly bytes: number;
	readonly operation: CompactStorageOperation;
	readonly live: Map<LeafId, CompactSlot>;
	liveBytes: number;
	readers: number;
	rewritten: boolean;
}

/**
 * Segment packing of compact current-state storage (senpi#4272, RULING-47): a flush batch is one
 * spool file and each leaf is read back by offset. A segment is deleted once its last live leaf is
 * released and no read of it is in flight. When its live bytes fall below half its size it is
 * rewritten once, so dead bytes on disk stay at most the live bytes of the segments holding them;
 * a failed rewrite halts spilling and keeps the old segment readable.
 */
export abstract class CompactSegmentStorage extends CompactSpoolStorage {
	/** Writes the texts back to back as one new file; undefined when the write failed and was reported. */
	protected async writeSegment(
		texts: readonly string[],
		operation: CompactStorageOperation,
	): Promise<CompactSegment | undefined> {
		const data = Buffer.from(texts.join(""), "utf16le");
		const path = await this.writeFile(data, operation, data.byteLength);
		if (path === undefined) return undefined;
		return { path, bytes: data.byteLength, operation, live: new Map(), liveBytes: 0, readers: 0, rewritten: false };
	}

	protected place(segment: CompactSegment, id: LeafId, offset: number, bytes: number): CompactSlot {
		const slot = { segment, offset, bytes };
		segment.live.set(id, slot);
		segment.liveBytes += bytes;
		return slot;
	}

	protected leave(id: LeafId, slot: CompactSlot): void {
		const segment = slot.segment;
		segment.live.delete(id);
		segment.liveBytes -= slot.bytes;
		this.settle(segment);
	}

	protected async readSlot(slot: CompactSlot): Promise<Buffer> {
		const { segment, offset, bytes } = slot;
		segment.readers++;
		try {
			return await this.readFile(segment.path, bytes, "leaf_read", { offset, length: bytes });
		} finally {
			segment.readers--;
			this.settle(segment);
		}
	}

	/** Deletes an empty segment no read holds, or queues the one rewrite of a mostly dead segment. */
	protected settle(segment: CompactSegment): void {
		if (!segment.live.size) {
			if (!segment.readers) this.discard(segment.path, segment.bytes);
		} else if (!segment.rewritten && segment.liveBytes * 2 < segment.bytes) {
			segment.rewritten = true;
			this.enqueue("reclaim", () => this.rewrite(segment));
		}
	}

	/** Copies the live leaves into a new segment, then repoints their slots; the old file goes when unread. */
	private async rewrite(segment: CompactSegment): Promise<void> {
		if (!this.spillAllowed || !segment.live.size) return;
		segment.readers++;
		let next: CompactSegment | undefined;
		try {
			const data = await this.readFile(segment.path, segment.bytes, "leaf_read");
			const moving = [...segment.live];
			const texts = moving.map(([, slot]) => data.toString("utf16le", slot.offset, slot.offset + slot.bytes));
			next = await this.writeSegment(texts, segment.operation);
			let offset = 0;
			for (const [id, slot] of moving) {
				// A leaf released while the copy was written stays out of the new segment's live set.
				if (next && segment.live.delete(id)) {
					segment.liveBytes -= slot.bytes;
					next.live.set(id, slot);
					next.liveBytes += slot.bytes;
					slot.segment = next;
					slot.offset = offset;
				}
				offset += slot.bytes;
			}
		} finally {
			segment.readers--;
			this.settle(segment);
			if (next) this.settle(next);
		}
	}
}
