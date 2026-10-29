import { type AnyModel, isModelType, type Provider } from "@earendil-works/pi-ai";
import type { ModelsJsonProvider } from "./model-config.ts";
import type { ProviderConfigInput } from "./provider-composer.ts";

/**
 * Where a composed provider's `base` came from. Builtin (pi-ai) transports read `model.baseUrl`, so a
 * models.json override always reaches them; a native extension `Provider` owns its transport and is
 * trusted with the override only when it declares `honorsModelBaseUrl` (senpi#4765).
 */
export type ProviderBaseOrigin = "builtin" | "native-extension";

export interface BaseUrlOverrideContext {
	readonly config: ModelsJsonProvider | undefined;
	readonly extension: ProviderConfigInput | undefined;
	readonly base: Provider | undefined;
	readonly baseOrigin: ProviderBaseOrigin;
	/** `base` models before models.json rewrote them: a native extension's own declared baseUrls. */
	readonly baseModels: readonly AnyModel[];
}

type ModelKind = "chat" | "image" | "classifier";

/**
 * `withheld`: the owner declared a different baseUrl and serves this model through its own transport
 * without declaring `honorsModelBaseUrl`, so that transport may not read `model.baseUrl`. Such models keep
 * their current destination; an owner opts in by reading `model.baseUrl` and declaring the flag (senpi#4765).
 */
type BaseUrlOverrideDecision =
	| { readonly kind: "none" }
	| { readonly kind: "apply"; readonly baseUrl: string }
	| { readonly kind: "withheld"; readonly baseUrl: string; readonly ownerBaseUrl: string };

function modelKind(model: AnyModel): ModelKind {
	if (isModelType(model, "image")) return "image";
	if (isModelType(model, "classifier")) return "classifier";
	return "chat";
}

function userBaseUrl(model: AnyModel, config: ModelsJsonProvider | undefined): string | undefined {
	const perModel =
		modelKind(model) === "chat" ? config?.models?.find((entry) => entry.id === model.id)?.baseUrl : undefined;
	return perModel ?? config?.baseUrl;
}

function ownerBaseUrl(model: AnyModel, context: BaseUrlOverrideContext): string | undefined {
	const kind = modelKind(model);
	const { extension } = context;
	if (extension) {
		const definition = extension.models?.find((entry) => (entry.type ?? "chat") === kind && entry.id === model.id);
		return definition?.baseUrl ?? extension.baseUrl;
	}
	if (context.baseOrigin === "builtin") return undefined;
	return context.baseModels.find((entry) => modelKind(entry) === kind && entry.id === model.id)?.baseUrl;
}

function ownsTransport(model: AnyModel, context: BaseUrlOverrideContext): boolean {
	const { extension } = context;
	if (!extension) return context.baseOrigin === "native-extension";
	if (isModelType(model, "image")) return extension.images?.[model.api] !== undefined;
	if (isModelType(model, "classifier")) return extension.classifiers?.[model.api] !== undefined;
	return extension.streamSimple !== undefined && model.api === extension.api;
}

function honorsModelBaseUrl(context: BaseUrlOverrideContext): boolean {
	return context.extension ? context.extension.honorsModelBaseUrl === true : context.base?.honorsModelBaseUrl === true;
}

function baseUrlOverrideDecision(model: AnyModel, context: BaseUrlOverrideContext): BaseUrlOverrideDecision {
	const baseUrl = userBaseUrl(model, context.config);
	if (baseUrl === undefined) return { kind: "none" };
	const owner = ownerBaseUrl(model, context);
	if (owner === undefined || owner === baseUrl || !ownsTransport(model, context) || honorsModelBaseUrl(context)) {
		return { kind: "apply", baseUrl };
	}
	return { kind: "withheld", baseUrl, ownerBaseUrl: owner };
}

/**
 * The last baseUrl-affecting composition step: a models.json `models[i].baseUrl`, else the provider
 * `baseUrl`, replaces whatever the extension, a native provider, or `oauth.modifyModels` set, for every
 * model type.
 */
export function applyUserBaseUrl(models: readonly AnyModel[], context: BaseUrlOverrideContext): AnyModel[] {
	return models.map((model) => {
		const decision = baseUrlOverrideDecision(model, context);
		return decision.kind === "apply" && model.baseUrl !== decision.baseUrl
			? { ...model, baseUrl: decision.baseUrl }
			: model;
	});
}
