import * as fs from "node:fs";
import * as path from "node:path";
import { containsPrefix, createMountRewrite, readFirmlinks } from "./alias-detector.ts";
import { isPresetRule } from "./config.ts";
import { evaluate, evaluateExternalSpelling, evaluateWithIdentity, type IdentityMatcher } from "./evaluate.ts";
import { createLocalEventEmitter, type PermissionEventEmitter } from "./events.ts";
import { decideExternalPaths } from "./external-spellings.ts";
import { type CanonicalPath, type CanonicalRule, identityMatches, PATH_IDENTITY_VERSION } from "./path-identity.ts";
import type { PathIdentityResolver } from "./path-identity-host.ts";
import { approvedFileVersion, approvedStoreRealPath, loadApproved } from "./storage.ts";
import {
	CorrectedError,
	DeniedError,
	type PendingEntry,
	type PermissionPresetName,
	RejectedError,
	type ReplyInput,
	type Request,
	type Rule,
	type Ruleset,
} from "./types.ts";

import { Wildcard } from "./wildcard.ts";

type RequestInput = Omit<Request, "id"> & { id?: string };

/** The canonical forms of one request (design 6.2): every alias names one operation, so any of them may match. */
export interface IdentityInput {
	readonly canonical: readonly CanonicalPath[];
	/** Error code when the executed path could not be canonicalized (6.1.3). */
	readonly unresolvable?: string;
	/** Set when a timed-out DENY rule of the class could have reached this request through an alias (6.5.1). */
	readonly failClosed?: boolean;
}

/** The kernel-supplied canonical of a cell operation, honoured only at the host's own PATH_IDENTITY_VERSION. */
export interface KernelCanonical {
	readonly canonical?: { readonly v: number; readonly path: string; readonly foldCase: boolean };
	readonly unresolvable?: string;
}

interface DecisionOptions {
	readonly approveBlanketAsk?: boolean;
	readonly presetBound?: boolean;
	readonly ruleAliases?: readonly string[] | undefined;
	readonly originalPaths?: readonly string[] | undefined;
	readonly identity?: IdentityInput | undefined;
}

/** The permission classes with a path target; only these take the identity route (M4). */
export const PATH_PERMISSIONS: ReadonlySet<string> = new Set(["read", "edit", "list", "grep"]);

/** Classes whose non-deny decision may have mutated the filesystem (M3): everything but the read-only ones. */
const READ_ONLY_PERMISSIONS: ReadonlySet<string> = new Set(["read", "list", "grep", "external_directory", "eval"]);

type RuleIdentityEntry = CanonicalRule | "literal-only" | "timed-out" | "pending";

interface RuleIdentity {
	entry: RuleIdentityEntry;
	fill?: Promise<void>;
	/** Whether the anchored prefix goes through an alias; undefined while the worker has not answered. */
	aliasBearing: boolean | undefined;
	/** The open-free walk of the anchored prefix, computed once per rules load; null when the walk failed. */
	walkedPrefix?: string | null;
}

const unresolvedPattern = (code: string) => `(path could not be resolved: ${code})`;

function uniq(values: readonly string[]): string[] {
	return [...new Set(values)];
}

/** Core service for managing permission requests and rule evaluation */
export class PermissionService {
	private pending = new Map<string, PendingEntry>();
	/** How each pending request was decided, so a re-check after an "Always" reply decides it the same way. */
	private pendingOptions = new Map<string, DecisionOptions>();
	private approved: Ruleset;
	private staticRuleset: Ruleset;
	private emitter: PermissionEventEmitter;
	private idCounter = 0;

	constructor(
		staticRuleset: Ruleset,
		approved: Ruleset,
		emitter: PermissionEventEmitter = createLocalEventEmitter(),
		preset?: PermissionPresetName,
		projectDir?: string,
		agentDir?: string,
		resolver?: PathIdentityResolver,
	) {
		this.staticRuleset = [...staticRuleset];
		this.approved = [...approved];
		this.emitter = emitter;
		this.preset = preset;
		this.resolver = resolver;
		this.mountRewrite = createMountRewrite(readFirmlinks());
		resolver?.onState((event) => this.emitter.emitResolverState(event));
		this.fillRuleIdentities();
		// The approved rules this service was seeded with are the persisted prefix; anything after
		// is this session's own (unsaved or just-saved) answers and survives a re-read.
		this.persistedApprovedCount = approved.length;
		this.projectDir = projectDir;
		this.agentDir = agentDir;
		this.protectedStorePath =
			agentDir !== undefined && projectDir !== undefined ? approvedStoreRealPath(agentDir, projectDir) : undefined;
		this.approvedVersion =
			agentDir === undefined || projectDir === undefined ? undefined : approvedFileVersion(agentDir, projectDir);
	}

	private readonly preset?: PermissionPresetName;
	private readonly projectDir?: string;
	private readonly agentDir?: string;
	private readonly protectedStorePath?: string;
	private persistedApprovedCount: number;
	private approvedVersion: string | undefined;
	private readonly resolver?: PathIdentityResolver;
	private readonly mountRewrite: (value: string) => string;
	/** Rule-side canonical forms, per pattern, filled through the resolver worker (6.5). */
	private readonly ruleIdentities = new Map<string, RuleIdentity>();

	/** True when a static or approved rule of a path class could match by identity (R3-H2 gate). */
	identityWanted(permission: string): boolean {
		if (!this.resolver || !PATH_PERMISSIONS.has(permission)) return false;
		return [...this.staticRuleset, ...this.approved].some(
			(rule) =>
				rule.pattern !== "*" && [...PATH_PERMISSIONS].some((member) => Wildcard.match(member, rule.permission)),
		);
	}

	private pathRules(): Rule[] {
		return [...this.staticRuleset, ...this.approved].filter(
			(rule) =>
				rule.pattern !== "*" && [...PATH_PERMISSIONS].some((member) => Wildcard.match(member, rule.permission)),
		);
	}

	private anchoredPrefix(pattern: string): string {
		const wildcard = pattern.search(/[*?]/u);
		const literal = wildcard < 0 ? pattern : pattern.slice(0, Math.max(pattern.lastIndexOf("/", wildcard), 0));
		if (literal === "") return "";
		return path.isAbsolute(literal) ? literal : path.join(this.projectDir ?? process.cwd(), literal);
	}

	/** Eager fill at rules load (R3-H1): one SOFT request per rule, outside the stall machinery. */
	private fillRuleIdentities(): void {
		if (!this.resolver) return;
		for (const rule of this.pathRules()) this.fillRule(rule.pattern, true);
	}

	private fillRule(pattern: string, soft: boolean): RuleIdentity {
		const existing = this.ruleIdentities.get(pattern);
		if (existing?.fill) return existing;
		const resolver = this.resolver;
		if (!resolver) return existing ?? { entry: "literal-only", aliasBearing: false };
		const retry =
			existing?.entry === "timed-out" &&
			resolver.breakerState(resolver.volumeKey(this.anchoredPrefix(pattern))) !== "open";
		if (existing && existing.entry !== "pending" && !retry) return existing;
		const identity: RuleIdentity = existing ?? { entry: "pending", aliasBearing: undefined };
		this.ruleIdentities.set(pattern, identity);
		const prefix = this.anchoredPrefix(pattern);
		if (prefix === "" && identity.aliasBearing === undefined) identity.aliasBearing = false;
		const live = () => this.ruleIdentities.get(pattern) === identity;
		if (identity.aliasBearing === undefined) {
			const store = (alias: boolean) => {
				if (live()) identity.aliasBearing = alias;
			};
			void resolver.detect(prefix, { soft, onLate: (value) => store(value !== false) }).then((alias) => {
				if (!soft || alias === false) store(alias);
			});
		}
		if (identity.walkedPrefix === undefined && prefix !== "") {
			const storeWalk = (value: string | null) => {
				if (live()) identity.walkedPrefix = value;
			};
			void resolver
				.walk(prefix, { soft, onLate: (value) => storeWalk(typeof value === "string" ? value : null) })
				.then(
					(walked) => storeWalk(walked),
					(error: unknown) => {
						if ((error as { code?: string }).code !== "ETIMEDOUT") storeWalk(null);
					},
				);
		}
		const storeRule = (rule: CanonicalRule | undefined) => {
			if (!live()) return;
			identity.entry = rule ?? "literal-only";
			identity.fill = undefined;
		};
		const fill = resolver
			.canonicalizeRule(pattern, this.projectDir, {
				soft,
				onLate: (value) => storeRule(value as CanonicalRule | undefined),
			})
			.then(storeRule, (error: unknown) => {
				if (this.ruleIdentities.get(pattern) !== identity) return;
				identity.fill = undefined;
				const code = (error as { code?: string }).code ?? "EUNKNOWN";
				if (code === "ETIMEDOUT") {
					// A soft miss leaves the lazy entry pending; a hard miss marks it timed out until the next probe.
					const was = identity.entry;
					identity.entry = soft ? "pending" : "timed-out";
					if (!soft && was !== "timed-out") {
						for (const rule of this.pathRules()) {
							if (rule.pattern === pattern && rule.action === "deny") {
								this.emitter.emitRuleIdentityUnavailable({ permission: rule.permission, pattern, code });
							}
						}
					}
					return;
				}
				identity.entry = "literal-only";
				console.warn(`permission: rule ${pattern} keeps literal matching only (${code})`);
			});
		identity.fill = fill;
		return identity;
	}

	/** The cached identity state of one rule pattern. */
	ruleIdentityState(pattern: string): RuleIdentityEntry {
		return this.ruleIdentities.get(pattern)?.entry ?? "pending";
	}

	/** Whether a rule's prefix goes through an alias; true while the worker has not answered yet. */
	ruleAliasBearing(pattern: string): boolean {
		return this.ruleIdentities.get(pattern)?.aliasBearing ?? true;
	}

	/**
	 * A decided non-read operation may have retargeted a rule chain (6.5, M3): drop the cached form of every
	 * rule whose anchored prefix shares a path with the mutated one, or every rule when no path is known.
	 */
	noteMutation(mutated?: string): void {
		for (const pattern of [...this.ruleIdentities.keys()]) {
			const prefix = this.anchoredPrefix(pattern);
			const related =
				mutated === undefined ||
				prefix === mutated ||
				prefix.startsWith(`${mutated}${path.sep}`) ||
				mutated.startsWith(`${prefix}${path.sep}`);
			if (!related) continue;
			this.ruleIdentities.delete(pattern);
		}
	}

	/** DENY rules of the class whose identity form is timed out or behind an open breaker (T(P) of 6.5.1). */
	private timedOutDenies(permission: string): Rule[] {
		return this.pathRules().filter(
			(rule) =>
				rule.action === "deny" &&
				Wildcard.match(permission, rule.permission) &&
				this.ruleIdentityState(rule.pattern) === "timed-out",
		);
	}

	/** Await every pending lazy fill a decision of this class needs; sync when nothing is pending. */
	private settleRules(permission: string): Promise<void> | undefined {
		const pending: Promise<void>[] = [];
		for (const rule of this.pathRules()) {
			if (!Wildcard.match(permission, rule.permission)) continue;
			const identity = this.fillRule(rule.pattern, false);
			if (identity.fill) pending.push(identity.fill);
		}
		return pending.length ? Promise.all(pending).then(() => undefined) : undefined;
	}

	/** Resolves once every in-flight rule fill (eager or lazy) has settled. */
	async identitySettled(): Promise<void> {
		const fills = [...this.ruleIdentities.values()]
			.map((identity) => identity.fill)
			.filter((fill) => fill !== undefined);
		await Promise.all(fills);
	}

	/**
	 * The identity input for one request (6.2, 6.5.1). Synchronous when the kernel supplied a current canonical
	 * and no rule of the class is pending or timed out; otherwise it awaits the resolver worker. Never throws:
	 * every resolver failure becomes `unresolvable`.
	 */
	prepareIdentity(
		permission: string,
		executed: readonly string[],
		cwd?: string,
		kernel?: KernelCanonical,
	): IdentityInput | Promise<IdentityInput> {
		const none: IdentityInput = { canonical: [] };
		if (!this.identityWanted(permission) || !this.resolver) return none;
		if (kernel?.unresolvable !== undefined && !kernel.canonical)
			return { canonical: [], unresolvable: kernel.unresolvable };
		const current = kernel?.canonical?.v === PATH_IDENTITY_VERSION ? kernel.canonical : undefined;
		const settle = this.settleRules(permission);
		const timedOut = () => this.timedOutDenies(permission);
		if (current && settle === undefined && timedOut().length === 0) {
			return { canonical: [{ path: current.path, foldCase: current.foldCase }] };
		}
		const resolver = this.resolver;
		return (async () => {
			if (settle) await settle;
			let canonical: CanonicalPath[] = [];
			let unresolvable: string | undefined;
			if (current) canonical = [{ path: current.path, foldCase: current.foldCase }];
			else {
				for (const value of executed) {
					try {
						canonical.push(await resolver.canonicalize(value, cwd));
					} catch (error) {
						unresolvable = (error as { code?: string }).code ?? "EUNKNOWN";
					}
				}
			}
			const failClosed = await this.failClosed(permission, executed, canonical, current !== undefined);
			return {
				canonical,
				...(unresolvable === undefined ? {} : { unresolvable }),
				...(failClosed ? { failClosed } : {}),
			};
		})();
	}

	/** 6.5.1: deny only when a timed-out DENY rule of the class could reach this request through an alias. */
	private async failClosed(
		permission: string,
		executed: readonly string[],
		canonical: readonly CanonicalPath[],
		kernelExact: boolean,
	): Promise<boolean> {
		const timedOut = this.timedOutDenies(permission);
		if (timedOut.length === 0 || !this.resolver) return false;
		const resolver = this.resolver;
		const aliasInPlay = async (value: string, index: number): Promise<boolean> => {
			const known = canonical[index];
			if (kernelExact && known) return known.path !== value;
			if (resolver.breakerState(resolver.volumeKey(value)) === "open") return true;
			return resolver.detect(value);
		};
		for (const [index, value] of executed.entries()) {
			if (await aliasInPlay(value, index)) return true;
			const requestCanonical = canonical[index]?.path ?? (await resolver.walk(value).catch(() => undefined));
			if (requestCanonical === undefined) return true;
			for (const rule of timedOut) {
				if (!this.ruleAliasBearing(rule.pattern)) continue;
				if (this.anchoredPrefix(rule.pattern) === "") continue;
				// The rule side was walked once at rules load on the worker; a pending or failed walk is over-inclusive.
				const walked = this.ruleIdentities.get(rule.pattern)?.walkedPrefix;
				if (typeof walked !== "string") return true;
				const foldCase =
					canonical[index]?.foldCase ?? (process.platform === "darwin" || process.platform === "win32");
				if (containsPrefix(walked, requestCanonical, this.mountRewrite, foldCase, (v) => v)) return true;
			}
		}
		return false;
	}

	/** Identity inputs by request id, so a refusal can name the layer of an identity-matched deny. */
	private readonly requestIdentities = new Map<string, IdentityInput>();

	requestIdentity(requestID: string): IdentityInput | undefined {
		return this.requestIdentities.get(requestID);
	}

	/** The identity predicate for one request: takes the RULE pattern only and tests every canonical path (H1). */
	identityMatcher(permission: string, identity: IdentityInput | undefined): IdentityMatcher | undefined {
		if (!identity || !PATH_PERMISSIONS.has(permission) || identity.canonical.length === 0) return undefined;
		return (rulePattern) => {
			const entry = this.ruleIdentities.get(rulePattern)?.entry;
			if (entry === undefined || typeof entry === "string") return false;
			return identity.canonical.some((request) => identityMatches(entry, request, Wildcard.match, path.sep));
		};
	}

	/**
	 * An "Always" answer another open session just persisted is honored on this session's very next
	 * decision (senpi#2465): the approved store is re-read only when its mtime+size changed, and the
	 * re-read replaces the persisted prefix while keeping this session's own answers.
	 */
	private refreshApproved(): void {
		if (this.projectDir === undefined || this.agentDir === undefined) return;
		const version = approvedFileVersion(this.agentDir, this.projectDir);
		if (version === this.approvedVersion) return;
		const fresh = loadApproved(this.agentDir, this.projectDir);
		this.approved = [...fresh, ...this.approved.slice(this.persistedApprovedCount)];
		this.persistedApprovedCount = fresh.length;
		this.approvedVersion = version;
	}

	/** deny > ask > allow. */
	private static readonly RESTRICTIVENESS: Readonly<Record<Rule["action"], number>> = { allow: 0, ask: 1, deny: 2 };

	/**
	 * The one decision for a call, used when it is asked and again whenever an "Always" reply re-checks
	 * the requests still pending. External paths use last-match-wins separately for the absolute
	 * lexical path, physical-prefix spellings from the component walk and their proven on-disk case; the most restrictive
	 * decision wins (deny > ask > allow). More than 16 spellings or 40 hops asks instead.
	 * Raw originalPaths are display-only. Remembered approvals
	 * match the resolved target and cannot override a deny from any spelling.
	 * Without `presetBound` it is last-match-wins over every rule. With
	 * `presetBound` the preset's rules and the user's settings and CLI rules are evaluated apart and
	 * the more restrictive wins, so no configured rule, in any order or layer, can widen the preset;
	 * only an "Always" answer given in this or an earlier session (`permissions-approved.jsonl`,
	 * explicit consent for that pattern) can then turn a remaining ask into allow.
	 */
	private decide(permission: string, target: string | readonly string[], options: DecisionOptions): Rule["action"] {
		return this.dispatchDecision(permission, target, options).action;
	}

	/** Share the decision and its relevant rules with the final dispatch fence. */
	dispatchDecision(
		permission: string,
		target: string | readonly string[],
		options: DecisionOptions = {},
	): { readonly action: Rule["action"]; readonly rules: readonly Rule[] } {
		this.refreshApproved();
		if (permission === "external_directory") {
			return decideExternalPaths(target, options.ruleAliases ?? [], (spelling, resolved, canonicalCase) =>
				this.decideTarget(permission, spelling, options, resolved, spelling !== resolved, canonicalCase),
			);
		}
		return this.decideTarget(permission, options.ruleAliases ?? target, options);
	}

	private decideTarget(
		permission: string,
		target: string | readonly string[],
		options: DecisionOptions,
		approvedTarget = target,
		preserveAncestry = false,
		canonicalCase?: (value: string) => string,
	): { readonly action: Rule["action"]; readonly rules: readonly Rule[] } {
		const identity = permission === "external_directory" ? undefined : options.identity;
		const matchesIdentity = this.identityMatcher(permission, identity);
		const evaluateTarget = (ruleset: Ruleset) =>
			preserveAncestry
				? evaluateExternalSpelling(target, ruleset, canonicalCase)
				: evaluateWithIdentity(permission, target, ruleset, matchesIdentity);
		const evaluateApproved = (approvedRuleset: Ruleset) =>
			preserveAncestry
				? evaluate(permission, approvedTarget, approvedRuleset)
				: evaluateWithIdentity(permission, approvedTarget, approvedRuleset, matchesIdentity);
		// 6.1.3 / 6.5.1: an unresolvable or alias-involved request while a DENY of its class exists or is
		// timed out is refused with the synthetic rule; a plain request never is.
		if (identity && PATH_PERMISSIONS.has(permission)) {
			const code = identity.failClosed ? "ETIMEDOUT" : identity.unresolvable;
			const denyExists = [...this.staticRuleset, ...this.approved].some(
				(rule) => rule.action === "deny" && Wildcard.match(permission, rule.permission),
			);
			if (code !== undefined && denyExists) {
				return { action: "deny", rules: [{ permission, pattern: unresolvedPattern(code), action: "deny" }] };
			}
		}
		// Defence in depth (HIGH 1): the agent's own tools never touch the approvals store, whatever
		// rules say. The target's real path is compared against the store's real path.
		if (this.protectedStorePath !== undefined && this.targetIsProtectedStore(target)) {
			return { action: "deny", rules: [{ permission, pattern: "*", action: "deny" }] };
		}
		if (!options.presetBound) {
			// HIGH 2: a configured (settings/CLI) decision outranks the preset's wildcard and any
			// approval. Evaluate the user's rules with their own last-match order; when the user's
			// decision is a deny it wins outright, and a preset wildcard-ask never masks it. The preset
			// only fills the gap the user left (no user rule matched, or the user decision is an ask).
			const userRules = this.staticRuleset.filter((rule) => !isPresetRule(rule));
			const userRule = evaluateTarget(userRules);
			if (userRules.includes(userRule) && userRule.action === "deny") {
				return { action: "deny", rules: [{ ...userRule }] };
			}
			const configured = evaluateTarget(this.staticRuleset);
			if (configured.action === "deny") return { action: "deny", rules: [{ ...configured }] };
			const approvedRule = evaluateApproved(this.approved);
			if (this.approved.includes(approvedRule) && approvedRule.action === "allow") {
				return { action: "allow", rules: [{ ...approvedRule }] };
			}
			// Full access means no prompts: a settings/CLI ask collapses to allow here, while a deny
			// stays denied. This is the one dedicated full-access decision (senpi#2465).
			const action = this.preset === "full-access" && configured.action === "ask" ? "allow" : configured.action;
			return { action, rules: [{ ...configured }] };
		}
		const presetRules = this.staticRuleset.filter((rule) => isPresetRule(rule));
		const userRules = this.staticRuleset.filter((rule) => !isPresetRule(rule));
		const presetRule = evaluateTarget(presetRules);
		const preset = presetRule.action === "ask" && options.approveBlanketAsk ? "allow" : presetRule.action;
		const userRule = evaluateTarget(userRules);
		const user = userRules.includes(userRule) ? userRule.action : undefined;
		const combined =
			user === undefined || PermissionService.RESTRICTIVENESS[preset] >= PermissionService.RESTRICTIVENESS[user]
				? preset
				: user;
		const rules = [presetRule, ...(user === undefined ? [] : [userRule])].map((rule) => ({ ...rule }));
		if (combined !== "ask") return { action: combined, rules };
		const remembered = evaluateApproved(this.approved);
		if (this.approved.includes(remembered) && remembered.action === "allow") {
			return { action: "allow", rules: [...rules, { ...remembered }] };
		}
		return { action: "ask", rules };
	}

	/** True when any target path resolves (real path, case-folded on macOS) to the approvals store. */
	private targetIsProtectedStore(target: string | readonly string[]): boolean {
		const store = this.protectedStorePath;
		if (store === undefined) return false;
		const targets = typeof target === "string" ? [target] : target;
		for (const value of targets) {
			const resolved = this.canonicalForCompare(value);
			if (resolved !== undefined && resolved === this.canonicalForCompare(store)) return true;
		}
		return false;
	}

	/**
	 * The real path to compare, case-folded on macOS. A path that does not exist yet (the store, and
	 * possibly its directories, before the first answer is written) resolves through its nearest
	 * EXISTING ancestor's real path at any depth, plus the missing tail, so the agent cannot create the
	 * store first. A bare name has no directory part and cannot name the store, which lives outside the
	 * workspace.
	 */
	private canonicalForCompare(value: string): string | undefined {
		if (!value.includes("/") && !value.includes(path.sep)) return undefined;
		const fold = (real: string) => (process.platform === "darwin" ? real.toLowerCase() : real);
		let existing = path.resolve(value);
		const missing: string[] = [];
		for (;;) {
			try {
				return fold(path.join(fs.realpathSync.native(existing), ...missing));
			} catch {
				const parent = path.dirname(existing);
				if (parent === existing) return undefined;
				missing.unshift(path.basename(existing));
				existing = parent;
			}
		}
	}

	/** Request permission for a tool call. Resolves if allowed, throws on denial. */
	async ask(
		request: RequestInput,
		{
			autoApproveAsk = false,
			approveBlanketAsk = false,
			presetBound = false,
			ruleAliases,
			executed,
		}: {
			readonly autoApproveAsk?: boolean;
			readonly approveBlanketAsk?: boolean;
			/**
			 * Decide as the more restrictive of the preset's decision and the user's (deny > ask > allow),
			 * so no user rule, in any order or layer, can widen the preset.
			 */
			readonly presetBound?: boolean;
			readonly ruleAliases?: readonly string[];
			/** The strings the tool opens (design 6.2): matched literally as aliases and by identity. */
			readonly executed?: readonly string[];
		} = {},
	): Promise<void> {
		const info: Request = {
			...request,
			id: request.id ?? this.nextRequestID(),
		};

		const deniedPatterns: string[] = [];
		let needsAsk = false;

		// The identity route is taken only with a path-class rule present (R3-H2); every resolver failure
		// becomes `unresolvable` here and never a thrown error. Executed strings travel as ruleAliases only,
		// so the written pattern stays the displayed and denied one (N8, N9).
		let identity: IdentityInput | undefined;
		if (executed && executed.length > 0 && this.identityWanted(info.permission)) {
			try {
				identity = await this.prepareIdentity(info.permission, executed, this.projectDir);
			} catch (error) {
				identity = { canonical: [], unresolvable: (error as { code?: string }).code ?? "EUNKNOWN" };
			}
		}
		if (identity) this.requestIdentities.set(info.id, identity);
		const options: DecisionOptions = {
			approveBlanketAsk,
			presetBound,
			ruleAliases,
			originalPaths: info.originalPaths,
			...(identity ? { identity } : {}),
		};
		for (const pattern of info.patterns) {
			const aliases =
				executed && executed.length > 0 ? uniq([...(ruleAliases ?? [pattern]), ...executed]) : ruleAliases;
			const action = this.decide(info.permission, pattern, { ...options, ruleAliases: aliases });
			if (action === "deny") {
				deniedPatterns.push(pattern);
				continue;
			}
			if (action === "ask" && !autoApproveAsk) {
				needsAsk = true;
			}
		}

		if (deniedPatterns.length > 0) {
			throw new DeniedError(deniedPatterns);
		}

		if (!READ_ONLY_PERMISSIONS.has(info.permission)) {
			if (executed && executed.length > 0) for (const value of executed) this.noteMutation(value);
			else this.noteMutation();
		}

		if (!needsAsk) {
			this.emitter.emitReplied(info.id, info.sessionID, "allow");
			return;
		}

		const pendingPromise = new Promise<void>((resolve, reject) => {
			const pendingEntry: PendingEntry = {
				info,
				resolve: () => {
					this.pending.delete(info.id);
					this.pendingOptions.delete(info.id);
					resolve();
				},
				reject: (error) => {
					this.pending.delete(info.id);
					this.pendingOptions.delete(info.id);
					reject(error);
				},
			};

			this.pending.set(info.id, pendingEntry);
			this.pendingOptions.set(info.id, options);
		});

		this.emitter.emitAsked(info);

		await pendingPromise;
	}

	/** Reply to a pending permission request */
	reply(input: ReplyInput): void {
		const existing = this.pending.get(input.requestID);
		if (!existing) {
			return;
		}

		this.pending.delete(input.requestID);
		this.pendingOptions.delete(input.requestID);
		this.emitter.emitReplied(existing.info.id, existing.info.sessionID, input.reply);

		if (input.reply === "reject") {
			existing.reject(input.message ? new CorrectedError(input.message) : new RejectedError());
			this.rejectPendingInSession(existing.info.sessionID);
			return;
		}

		existing.resolve();

		if (input.reply === "once") {
			return;
		}

		for (const pattern of input.always ?? existing.info.always) {
			this.approved.push({
				permission: existing.info.permission,
				pattern,
				action: "allow",
			});
		}

		this.resolveCoveredPendingInSession(existing.info.sessionID);
	}

	/** List all pending permission requests */
	list(): Request[] {
		return Array.from(this.pending.values(), (entry) => ({
			...entry.info,
			patterns: [...entry.info.patterns],
			always: [...entry.info.always],
			...(entry.info.originalPaths ? { originalPaths: [...entry.info.originalPaths] } : {}),
			metadata: { ...entry.info.metadata },
			tool: entry.info.tool ? { ...entry.info.tool } : undefined,
		}));
	}

	/** Get the current approved ruleset */
	getApproved(): Ruleset {
		return this.approved.map((rule) => ({ ...rule }));
	}

	/**
	 * This session's own approved rules (its answers), identified by permission+pattern+action, not
	 * by index: a refresh that grows or shrinks the persisted prefix never duplicates or drops them.
	 */
	getSessionApproved(): Ruleset {
		return this.approved.slice(this.persistedApprovedCount).map((rule) => ({ ...rule }));
	}

	private nextRequestID(): string {
		this.idCounter += 1;
		return `permission-${this.idCounter}`;
	}

	private rejectPendingInSession(sessionID: string): void {
		for (const [requestID, entry] of Array.from(this.pending.entries())) {
			if (entry.info.sessionID !== sessionID) {
				continue;
			}

			this.pending.delete(requestID);
			this.pendingOptions.delete(requestID);
			this.emitter.emitReplied(entry.info.id, entry.info.sessionID, "reject");
			entry.reject(new RejectedError());
		}
	}

	private resolveCoveredPendingInSession(sessionID: string): void {
		for (const [requestID, entry] of Array.from(this.pending.entries())) {
			if (entry.info.sessionID !== sessionID) {
				continue;
			}

			const options = this.pendingOptions.get(requestID) ?? {};
			const isAllowed = entry.info.patterns.every(
				(pattern) => this.decide(entry.info.permission, pattern, options) === "allow",
			);

			if (!isAllowed) {
				continue;
			}

			this.pending.delete(requestID);
			this.pendingOptions.delete(requestID);
			this.emitter.emitReplied(entry.info.id, entry.info.sessionID, "always");
			entry.resolve();
		}
	}
}
