import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export type SnippetLanguage = "ts" | "bash" | "json";

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;

const languageIds: Record<SnippetLanguage, "typescript" | "bash" | "json"> = {
	ts: "typescript",
	bash: "bash",
	json: "json",
};

let highlighterPromise: Promise<Highlighter> | undefined;

/**
 * Lazily creates the fine-grained Shiki highlighter. Grammars and themes are
 * dynamic imports, so nothing is downloaded until the first call. The promise
 * is cached for the lifetime of the page.
 */
export function loadHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighterCore({
			themes: [
				import("@shikijs/themes/github-light"),
				import("@shikijs/themes/github-dark"),
			],
			langs: [
				import("@shikijs/langs/typescript"),
				import("@shikijs/langs/bash"),
				import("@shikijs/langs/json"),
			],
			engine: createJavaScriptRegexEngine(),
		});
	}

	return highlighterPromise;
}

/** Highlights `code` with the github light/dark dual themes. */
export async function highlight(code: string, language: SnippetLanguage): Promise<string> {
	const highlighter = await loadHighlighter();

	return highlighter.codeToHtml(code, {
		lang: languageIds[language],
		themes: {
			light: "github-light",
			dark: "github-dark",
		},
		defaultColor: false,
	});
}
