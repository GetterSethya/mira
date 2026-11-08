import { createJavaScriptRegexEngine, getSingletonHighlighter } from 'shiki';

export const THEME = 'github-dark';
export const DOC_LIGHT_THEME = 'github-light-high-contrast';
export const DOC_DARK_THEME = 'github-dark-high-contrast';

export type CodeLang =
  | 'ts'
  | 'typescript'
  | 'tsx'
  | 'bash'
  | 'shell'
  | 'json'
  | 'sql'
  | 'ini'
  | 'svelte'
  | 'vue'
  | 'text';

const LANGS = [
  'ts',
  'typescript',
  'tsx',
  'bash',
  'shell',
  'json',
  'sql',
  'ini',
  'svelte',
  'vue'
] as const;

// One highlighter shared across all samples so the TextMate grammars are
// loaded once per prerender instead of once per code block. The JavaScript
// regex engine keeps the build free of the Oniguruma WASM binary.
let highlighterPromise: ReturnType<typeof getSingletonHighlighter> | undefined;

function loadHighlighter() {
  highlighterPromise ??= getSingletonHighlighter({
    themes: [THEME, DOC_LIGHT_THEME, DOC_DARK_THEME],
    langs: [...LANGS],
    engine: createJavaScriptRegexEngine({ forgiving: true })
  });

  return highlighterPromise;
}

export function getHighlighter() {
  return loadHighlighter();
}

export async function highlightCode(code: string, lang: CodeLang) {
  const highlighter = await loadHighlighter();

  return highlighter.codeToHtml(code, {
    lang,
    themes: {
      light: DOC_LIGHT_THEME,
      dark: DOC_DARK_THEME
    },
    defaultColor: false
  });
}
