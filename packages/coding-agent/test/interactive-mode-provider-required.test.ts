import { describe, expect, test, vi } from "vitest";
import { formatNoApiKeyFoundMessage } from "../src/core/auth-guidance.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const GUIDANCE = formatNoApiKeyFoundMessage("unknown");

function makeFakeThis(startupProviderGuidanceShown: boolean) {
	return {
		isInitialized: true,
		startupProviderGuidanceShown,
		showWarning: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
	};
}

type FakeThis = ReturnType<typeof makeFakeThis>;

// senpi#4329: the shared notice is surface-neutral; the TUI adds its own commands to it.
function expectTuiCommands(fakeThis: FakeThis): void {
	const shown = String(fakeThis.showWarning.mock.calls.at(-1)?.[0]);
	expect(shown.match(/\/(?:login|model)\b/g)).toEqual(["/login", "/model"]);
}

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: FakeThis,
	event: Record<string, unknown>,
) => Promise<void>;

describe("first-run provider guidance in the interactive mode", () => {
	test("#given the startup warning already said no models are available #when the session reports provider_required #then nothing more is shown the first time", async () => {
		// given
		const fakeThis = makeFakeThis(true);

		// when
		await handleEvent.call(fakeThis, { type: "provider_required", notice: GUIDANCE });

		// then
		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("#given the startup notice was absorbed #when the session reports provider_required again later #then the guidance is shown as a warning", async () => {
		// given
		const fakeThis = makeFakeThis(true);
		await handleEvent.call(fakeThis, { type: "provider_required", notice: GUIDANCE });

		// when
		await handleEvent.call(fakeThis, { type: "provider_required", notice: GUIDANCE });

		// then
		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(fakeThis.showWarning).toHaveBeenCalledWith(expect.stringContaining(GUIDANCE));
		expectTuiCommands(fakeThis);
	});

	test("#given no startup warning was shown #when the session reports provider_required #then the guidance is shown once as a warning, never as an error", async () => {
		// given
		const fakeThis = makeFakeThis(false);

		// when
		await handleEvent.call(fakeThis, { type: "provider_required", notice: GUIDANCE });

		// then
		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(fakeThis.showWarning).toHaveBeenCalledWith(expect.stringContaining(GUIDANCE));
		expectTuiCommands(fakeThis);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
