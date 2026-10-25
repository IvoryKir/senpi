import type { AssistantMessage } from "@earendil-works/pi-ai";
import { redactSecrets } from "../sensitive-output.ts";
import type { FallbackLogger } from "./log.ts";

// A route that does not serve a configured model id: the code an OpenAI-compatible gateway returns,
// and the text a gateway uses when no provider behind it serves that id.
const MODEL_CONFIG_ERROR = /\bmodel_not_found\b|\bunknown provider for model\b/i;
const EXCERPT_LIMIT = 500;

export interface ModelConfigErrorEvent {
	type: "model_config_error";
	model: string;
	provider: string;
	errorExcerpt: string;
}

export interface ModelConfigErrorReporter {
	/** Emit the event and log warning once per model and session for a message already marked. */
	report(message: AssistantMessage, sessionId: string): void;
}

/**
 * A model configuration error is never retried or fallen back: another model would answer a request
 * the caller did not make (senpi#4282).
 */
export function isModelConfigError(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && MODEL_CONFIG_ERROR.test(errorMessage);
}

/**
 * Redact and mark a failed message that hit a model configuration error. Runs at `message_end`, before the
 * message is persisted or published, so the provider body never reaches a sink unredacted.
 */
export function markModelConfigError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !isModelConfigError(message.errorMessage)) return false;
	message.errorMessage = redactSecrets(message.errorMessage ?? "");
	message.errorCause = { type: "model_config", model: `${message.provider}/${message.model}` };
	return true;
}

export function createModelConfigErrorReporter(
	logger: FallbackLogger,
	emit: (event: ModelConfigErrorEvent) => void,
): ModelConfigErrorReporter {
	const reported = new Set<string>();
	return {
		report(message, sessionId) {
			const model = `${message.provider}/${message.model}`;
			const key = `${sessionId}\u0000${model}`;
			if (reported.has(key)) return;
			reported.add(key);
			const errorMessage = message.errorMessage ?? "";
			logger.warn("model_config_error", { model, provider: message.provider, errorMessage });
			emit({
				type: "model_config_error",
				model,
				provider: message.provider,
				errorExcerpt: errorMessage.slice(0, EXCERPT_LIMIT),
			});
		},
	};
}
