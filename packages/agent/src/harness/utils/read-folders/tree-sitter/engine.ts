import type { Language, Parser as ParserType } from "web-tree-sitter";
import { composeFoldResult } from "../compose.ts";
import type { ReadFolder, ReadFolderInput, ReadFolderResult } from "../types.ts";
import { type GrammarResolver, resolveGrammarPath, resolveRuntimePath } from "./grammar-assets.ts";
import { foldRangesFromSyntax, type SyntaxNode, type TreeSitterLanguage } from "./syntax.ts";

/** A structural read must never outlast this budget: an exhausted parse falls back, it does not stall. */
export const TREE_SITTER_PARSE_BUDGET_MS = 250;
export const TREE_SITTER_FOLDER_ID = "tree-sitter-wasm";
export const TREE_SITTER_FOLDER_VERSION = "1";

export type TreeSitterFolderOptions = {
	/** Used verbatim when a grammar is absent, the parse fails or the budget is exhausted. */
	readonly fallback: ReadFolder;
	readonly parseBudgetMs?: number;
	readonly resolveGrammar?: GrammarResolver;
	readonly resolveRuntime?: () => Promise<string | undefined>;
	/** Controls grammar/parser sharing; runtime initialization is always shared by resolved path. */
	readonly cache?: boolean;
};

type Loaded = { readonly parser: ParserType; readonly language: TreeSitterLanguage };

const runtimes = new Map<string | undefined, Promise<typeof import("web-tree-sitter") | undefined>>();
const grammars = new Map<TreeSitterLanguage, Promise<Loaded | undefined>>();

async function loadRuntime(
	resolveRuntime: () => Promise<string | undefined>,
): Promise<typeof import("web-tree-sitter") | undefined> {
	try {
		const wasm = await resolveRuntime();
		const existing = runtimes.get(wasm);
		if (existing) return existing;
		const pending = (async () => {
			const module = await import("web-tree-sitter");
			await module.Parser.init(wasm ? { locateFile: () => wasm } : undefined);
			return module;
		})().catch(() => {
			runtimes.delete(wasm);
			return undefined;
		});
		runtimes.set(wasm, pending);
		return pending;
	} catch {
		return undefined;
	}
}

async function loadParser(language: TreeSitterLanguage, options: TreeSitterFolderOptions): Promise<Loaded | undefined> {
	const resolveGrammar = options.resolveGrammar ?? resolveGrammarPath;
	const resolveRuntime = options.resolveRuntime ?? resolveRuntimePath;
	const grammar = await resolveGrammar(language);
	if (!grammar) return undefined;
	const module = await loadRuntime(resolveRuntime);
	return module && instantiate(module, grammar, language);
}

async function instantiate(
	module: typeof import("web-tree-sitter"),
	grammar: string,
	language: TreeSitterLanguage,
): Promise<Loaded | undefined> {
	try {
		const loaded: Language = await module.Language.load(grammar);
		const parser = new module.Parser();
		parser.setLanguage(loaded);
		return { parser, language };
	} catch {
		return undefined;
	}
}

function foldWith(loaded: Loaded, budgetMs: number, input: ReadFolderInput, fallback: ReadFolder): ReadFolderResult {
	const deadline = performance.now() + budgetMs;
	let tree: ReturnType<ParserType["parse"]> = null;
	try {
		tree = loaded.parser.parse(input.text, null, { progressCallback: () => performance.now() > deadline });
		if (!tree) return fallback.fold(input);
		const scan = foldRangesFromSyntax(tree.rootNode as unknown as SyntaxNode, input.settings);
		if (scan.status === "parse_failure") return fallback.fold(input);
		return composeFoldResult(input.text, scan);
	} catch {
		// A grammar/runtime fault is a fallback condition, never a failed read.
		return fallback.fold(input);
	} finally {
		tree?.delete();
		// Parsing resumes mid-document after a cancelled parse unless the parser is reset.
		loaded.parser.reset();
	}
}

/**
 * Load the grammar for one language and return a folder that produces the same fold-boundary
 * output the heuristic produces, with the heuristic itself as the fallback. Grammars load lazily,
 * on the first structural read for their language.
 */
export async function loadTreeSitterFolder(
	language: TreeSitterLanguage,
	options: TreeSitterFolderOptions,
): Promise<ReadFolder | undefined> {
	const load = () => loadParser(language, options);
	const loaded = await (options.cache === false
		? load()
		: (grammars.get(language) ??
			(() => {
				const pending = load().then((loaded) => {
					if (!loaded) grammars.delete(language);
					return loaded;
				});
				grammars.set(language, pending);
				return pending;
			})()));
	if (!loaded) return undefined;
	const budgetMs = options.parseBudgetMs ?? TREE_SITTER_PARSE_BUDGET_MS;
	return Object.freeze({
		id: TREE_SITTER_FOLDER_ID,
		version: TREE_SITTER_FOLDER_VERSION,
		fold: (input: ReadFolderInput) => foldWith(loaded, budgetMs, input, options.fallback),
	});
}

/** Test seam: drop the memoized runtime/grammars so a resolver change is observable. */
export function resetTreeSitterGrammars(): void {
	runtimes.clear();
	grammars.clear();
}
