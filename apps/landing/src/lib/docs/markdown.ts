import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';

import { DOC_DARK_THEME, DOC_LIGHT_THEME, getHighlighter } from '../highlight';
import { slugify } from './headings';

const supportedLanguages = new Set([
  'ts',
  'typescript',
  'tsx',
  'bash',
  'shell',
  'json',
  'sql',
  'ini',
  'svelte',
  'vue',
  'text'
]);

const packageManagers = ['pnpm', 'npm', 'yarn', 'bun'] as const;

const languageLabels: Record<string, string> = {
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  bash: 'Shell',
  shell: 'Shell',
  json: 'JSON',
  sql: 'SQL',
  ini: 'Env',
  svelte: 'Svelte',
  vue: 'Vue',
  text: 'Text',
  install: 'Install'
};

function normalizeLanguage(language: string) {
  const name = language.trim().toLowerCase();

  if (name === 'env' || name === 'dotenv') return 'ini';
  if (name === 'js') return 'ts';

  return supportedLanguages.has(name) ? name : 'text';
}

export function getHeadings(html: string) {
  const headings: Array<{ id: string; text: string; level: number }> = [];
  const pattern = /<h([23])\s+id="([^"]+)"[^>]*>(.*?)<\/h\1>/gs;

  for (const match of html.matchAll(pattern)) {
    const text = match[3]
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();

    if (text) headings.push({ id: match[2], text, level: Number(match[1]) });
  }

  return headings;
}

function packageManagerLine(line: string, manager: (typeof packageManagers)[number]) {
  if (manager === 'pnpm') return line;

  const indent = line.slice(0, line.length - line.trimStart().length);
  const trimmed = line.trimStart();

  const add = /^pnpm add (.*)$/.exec(trimmed);
  if (add) {
    const rest = add[1];
    const dev = rest.startsWith('-D ');
    const packages = dev ? rest.slice(3) : rest;

    if (manager === 'npm') return `${indent}npm install ${dev ? '-D ' : ''}${packages}`;
    if (manager === 'yarn') return `${indent}yarn add ${dev ? '-D ' : ''}${packages}`;
    return `${indent}bun add ${dev ? '-d ' : ''}${packages}`;
  }

  const dlx = /^pnpm dlx (.*)$/.exec(trimmed);
  if (dlx) {
    const target = dlx[1];
    if (manager === 'npm') return `${indent}npx ${target}`;
    if (manager === 'yarn') return `${indent}yarn dlx ${target}`;
    return `${indent}bunx ${target}`;
  }

  return line;
}

function installVariants(code: string) {
  const variants: Record<string, string> = {};

  for (const manager of packageManagers) {
    variants[manager] = code
      .split('\n')
      .map((line) => packageManagerLine(line, manager))
      .join('\n');
  }

  return variants;
}

function copyButton(label: string) {
  return `<button class="code-block__copy" type="button" data-copy aria-label="Copy ${label} code"><svg class="icon-copy" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="1.5"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"></path></svg><svg class="icon-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg></button>`;
}

function codeBar(label: string, extra = '') {
  return `<div class="code-block__bar"><span class="code-block__lang">${label}</span>${extra}<span class="code-block__actions">${copyButton(
    label
  )}</span></div>`;
}

function renderCode(lang: string, code: string, highlighter: Awaited<ReturnType<typeof getHighlighter>>) {
  return highlighter.codeToHtml(code, {
    lang: normalizeLanguage(lang),
    themes: {
      light: DOC_LIGHT_THEME,
      dark: DOC_DARK_THEME
    },
    defaultColor: false
  });
}

function renderInstallBlock(
  code: string,
  highlighter: Awaited<ReturnType<typeof getHighlighter>>
) {
  const variants = installVariants(code);

  const options = packageManagers
    .map((manager) => `<option value="${manager}">${manager}</option>`)
    .join('');

  const select = `<label class="code-block__pm"><span class="sr-only">Package manager</span><select data-pm-select aria-label="Package manager">${options}</select></label>`;

  const panels = packageManagers
    .map(
      (manager) =>
        `<div class="code-block__panel${manager === 'pnpm' ? ' is-active' : ''}" data-pm-panel="${manager}" role="tabpanel" aria-label="${manager}"${
          manager === 'pnpm' ? '' : ' hidden'
        }>${renderCode('bash', variants[manager], highlighter)}</div>`
    )
    .join('');

  return `<div class="code-block code-block--install" data-code-block data-language="install" role="group" aria-label="Install commands">${codeBar(
    'Install',
    select
  )}${panels}</div>`;
}

let rendererPromise: Promise<InstanceType<typeof MarkdownIt>> | undefined;

async function makeRenderer() {
  const highlighter = await getHighlighter();
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false
  });

  md.use(anchor, { slugify });

  md.renderer.rules.table_open = (tokens, idx, options, _env, self) =>
    `<div class="table-wrap" tabindex="0" role="region" aria-label="Table, scroll horizontally for more columns">${self.renderToken(
      tokens,
      idx,
      options
    )}`;

  md.renderer.rules.table_close = (tokens, idx, options, _env, self) =>
    `${self.renderToken(tokens, idx, options)}</div>`;

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const info = token.info.trim().split(/\s+/).filter(Boolean);
    const lang = info[0] ?? 'text';

    if (lang === 'install') {
      return renderInstallBlock(token.content, highlighter);
    }

    const label = languageLabels[lang] ?? 'Code';

    return `<div class="code-block" data-code-block data-language="${lang}" role="region" aria-label="${label} code">${codeBar(
      label
    )}${renderCode(lang, token.content, highlighter)}</div>`;
  };

  return md;
}

function getRenderer() {
  rendererPromise ??= makeRenderer();
  return rendererPromise;
}

export async function renderMarkdown(source: string) {
  const md = await getRenderer();
  return md.render(source);
}
