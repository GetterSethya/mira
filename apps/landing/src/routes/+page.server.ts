import { renderMarkdown } from '$lib/docs/markdown';
import { highlightCode } from '$lib/highlight';
import { quickstartGroups, quickstartSamples } from '$lib/quickstart-samples';

const editorKeys = new Set(quickstartGroups.flatMap((group) => group.keys));

export const load = async () => ({
  samples: await Promise.all(
    quickstartSamples.map(async (sample) => ({
      ...sample,
      html: editorKeys.has(sample.key)
        ? await highlightCode(sample.code, sample.lang)
        : await renderMarkdown(
            `\`\`\`${sample.key === 'install' ? 'install' : sample.lang}\n${sample.code}\n\`\`\``
          )
    }))
  )
});
