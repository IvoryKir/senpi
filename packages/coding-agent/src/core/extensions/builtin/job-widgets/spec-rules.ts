/**
 * What rules feed: the fields each rule writes, the sources it reads, and how a field is fed
 * across all rules. Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import { patternGroupNames } from "./matcher.ts";
import type { JobWidgetAgg, JobWidgetRule, JobWidgetRuleField, JobWidgetSpec } from "./spec-types.ts";

/** Whether a rule's `from` names the source `id`. */
export function ruleReadsSource(from: string, id: string): boolean {
	if (from === "*") return true;
	if (from.endsWith("*")) return id.startsWith(from.slice(0, -1));
	return from === id;
}

/** The fields a rule feeds: one per named group but `key`, then its `count`. */
export function ruleFields(rule: JobWidgetRule): JobWidgetRuleField[] {
	const fields: JobWidgetRuleField[] = [];
	for (const group of new Set(patternGroupNames(rule.match))) {
		if (group !== rule.key) fields.push({ field: group, text: group === rule.text, count: false });
	}
	if (rule.count !== undefined) fields.push({ field: rule.count, text: false, count: true });
	return fields;
}

/** Whether an aggregation needs numbers: `count` and `rate` read matches, not values. */
export function aggNeedsValue(agg: JobWidgetAgg): boolean {
	return agg !== "count" && agg !== "rate";
}

/** How rules feed a field: whether any feed is a number or keeps text, and the groups keying it. */
export interface FieldFeed {
	value: boolean;
	text: boolean;
	keyGroups: Set<string>;
}

export function fieldFeeds(spec: JobWidgetSpec): Map<string, FieldFeed> {
	const fields = new Map<string, FieldFeed>();
	for (const rule of spec.rules) {
		for (const { field, text, count } of ruleFields(rule)) {
			const feed = fields.get(field) ?? { value: false, text: false, keyGroups: new Set<string>() };
			feed.value ||= !text && !count;
			feed.text ||= text;
			if (rule.key !== undefined) feed.keyGroups.add(rule.key);
			fields.set(field, feed);
		}
	}
	return fields;
}

/** Fields some rule splits by key; every other field keeps a single series. */
export function keyedFields(spec: JobWidgetSpec | undefined): Set<string> {
	const keyed = new Set<string>();
	for (const rule of spec?.rules ?? []) {
		if (rule.key === undefined) continue;
		for (const { field } of ruleFields(rule)) keyed.add(field);
	}
	return keyed;
}
