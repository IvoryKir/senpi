import type { RecoveryCarrier } from "../../core/session-recovery-identity.ts";

/**
 * The producer half of RULING-36a/40: one lifetime ordinal per acceptance unit (on a worker, the S04a output-frame
 * ordinal itself, never reset) and each message's first canonical ordinal, bound by the producer until its outer end.
 */
export class CompactProducerStamp {
	private next = 0;
	private readonly first = new Map<string, number>();

	stamp(
		carrier: RecoveryCarrier | undefined,
		canonical: { readonly type: string } | undefined,
	): { readonly ordinal: number; readonly firstOrdinal?: number } {
		const ordinal = this.next++;
		if (!carrier || !canonical) return { ordinal };
		const firstOrdinal = this.first.get(carrier.messageId) ?? ordinal;
		if (canonical.type === "message_end") this.first.delete(carrier.messageId);
		else this.first.set(carrier.messageId, firstOrdinal);
		return { ordinal, firstOrdinal };
	}

	/** A replacement starts a new epoch, in which no message of the old one continues. */
	forget(): void {
		this.first.clear();
	}
}
