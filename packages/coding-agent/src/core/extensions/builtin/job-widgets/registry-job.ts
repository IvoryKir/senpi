/**
 * One job in a session's widget registry: its text sources, its derivation runtime (replaced by a
 * fresh one whenever a spec is installed), and where its spec request stands. A job joins the
 * session's `job_widget_state` once its first spec request starts; before that its row is plain.
 */
import type { JobWidgetBrief, JobWidgetJobKind } from "./author-types.ts";
import type { LineMatcher } from "./matcher.ts";
import type { JobWidgetRequestOutcome } from "./request-controller.ts";
import type { JobWidgetRequestJob } from "./request-policy.ts";
import { JobWidgetRuntime } from "./runtime.ts";
import type { JobTextSource } from "./source-types.ts";
import type { JobWidgetEntry } from "./view-types.ts";

/** What a host says about a job when it registers it; the kind lives beside the brief, not in it. */
export type JobWidgetBriefText = Omit<JobWidgetBrief, "kind">;

export interface JobWidgetJobInput {
	/** `bash_id` or `st_` task id; unique within the session. */
	readonly id: string;
	readonly kind: JobWidgetJobKind;
	readonly sources: readonly JobTextSource[];
	readonly brief: JobWidgetBriefText;
	/** When the job started; its age gates the first spec request. Defaults to now. */
	readonly startedAtMs?: number;
}

export class JobWidgetJob implements JobWidgetRequestJob {
	readonly id: string;
	readonly kind: JobWidgetJobKind;
	readonly startTime: number;
	readonly sources: readonly JobTextSource[];
	brief: JobWidgetBrief;
	runtime: JobWidgetRuntime;
	settled = false;
	readonly #matcher: LineMatcher;
	#asked = false;
	#authoring = false;
	#skippedAtMs: number | undefined;

	constructor(input: JobWidgetJobInput, matcher: LineMatcher) {
		this.id = input.id;
		this.kind = input.kind;
		this.startTime = input.startedAtMs ?? Date.now();
		this.sources = input.sources;
		this.brief = { ...input.brief, kind: input.kind };
		this.#matcher = matcher;
		this.runtime = new JobWidgetRuntime({ spec: undefined, matcher, startTime: this.startTime });
	}

	ingest(): void {
		this.runtime.ingest(this.sources, this.settled);
	}

	requestStarted(): void {
		this.#asked = true;
		this.#authoring = true;
	}

	requestSettled(outcome: JobWidgetRequestOutcome): void {
		this.#authoring = false;
		if (outcome.kind === "installed") {
			this.runtime = new JobWidgetRuntime({ spec: outcome.spec, matcher: this.#matcher, startTime: this.startTime });
			this.ingest();
		} else if (outcome.kind === "skipped" && !this.runtime.spec) {
			this.#skippedAtMs = Date.now();
		}
	}

	entry(): JobWidgetEntry | undefined {
		if (this.#skippedAtMs !== undefined) {
			return { id: this.id, kind: this.kind, state: "skipped", updatedAtMs: this.#skippedAtMs };
		}
		if (!this.#asked) return undefined;
		const brief = this.brief;
		const derived = this.runtime.derive({
			label: brief.intent ?? brief.task ?? brief.command ?? this.id,
			...(brief.stage === undefined ? {} : { stage: brief.stage }),
			lineStage: this.kind === "bash",
			authoring: this.#authoring,
			settled: this.settled,
		});
		return {
			id: this.id,
			kind: this.kind,
			state: derived.state,
			view: derived.view,
			updatedAtMs: derived.updatedAtMs,
		};
	}
}
