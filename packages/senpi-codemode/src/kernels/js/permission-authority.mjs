export function authorityDecision(current, bound, kernel) {
	if (current) {
		const word = Atomics.load(new Int32Array(current.authority), 0);
		if (!(word & 2)) return "refuse";
		return word & 1 ? "check" : "pass";
	}
	const authorities = bound.length ? bound : [kernel];
	return authorities.every((token) => (Atomics.load(new Int32Array(token.authority), 0) & 3) === 2)
		? "pass" : "refuse";
}
