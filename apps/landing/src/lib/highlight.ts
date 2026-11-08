import { createJavaScriptRegexEngine, getSingletonHighlighter } from 'shiki';

const THEME = 'github-dark';

// One highlighter shared across all samples so the TextMate grammars are
// loaded once per prerender instead of once per code block. The JavaScript
// regex engine keeps the build free of the Oniguruma WASM binary.
let highlighterPromise: ReturnType<typeof getSingletonHighlighter> | undefined;

function loadHighlighter() {
  highlighterPromise ??= getSingletonHighlighter({
    themes: [THEME],
    langs: ['ts', 'typescript', 'bash', 'shell', 'json', 'sql'],
    engine: createJavaScriptRegexEngine({ forgiving: true })
  });

  return highlighterPromise;
}

export async function highlightCode(code: string, lang: 'ts' | 'bash' | 'json') {
  const highlighter = await loadHighlighter();

  return highlighter.codeToHtml(code, {
    lang,
    theme: THEME
  });
}
