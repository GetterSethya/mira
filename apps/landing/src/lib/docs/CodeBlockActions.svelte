<script lang="ts">
  import { onMount } from 'svelte';
  import { afterNavigate } from '$app/navigation';

  function setPackageManager(manager: string) {
    for (const block of document.querySelectorAll<HTMLElement>('.code-block--install')) {
      const select = block.querySelector<HTMLSelectElement>('[data-pm-select]');
      if (select) select.value = manager;

      for (const panel of block.querySelectorAll<HTMLElement>('[data-pm-panel]')) {
        const active = panel.dataset.pmPanel === manager;
        panel.hidden = !active;
        panel.classList.toggle('is-active', active);
      }
    }

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('mira.docs.pm', manager);
    }
  }

  async function copyCode(button: HTMLElement) {
    const block = button.closest('.code-block');
    if (!(block instanceof HTMLElement)) return;

    const panel = block.querySelector<HTMLElement>('[data-pm-panel]:not([hidden])');
    const pre = panel?.querySelector('pre') ?? block.querySelector('pre');
    const code = pre?.innerText ?? pre?.textContent ?? '';
    if (!code) return;

    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const fallback = document.createElement('textarea');
      fallback.value = code;
      fallback.setAttribute('readonly', '');
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      fallback.remove();
    }

    const ariaLabel = button.getAttribute('aria-label') ?? 'Copy code';
    button.setAttribute('aria-label', 'Copied');
    button.classList.add('is-copied');
    window.setTimeout(() => {
      button.setAttribute('aria-label', ariaLabel);
      button.classList.remove('is-copied');
    }, 1600);
  }

  afterNavigate(() => {
    const saved = localStorage.getItem('mira.docs.pm');
    if (saved === 'pnpm' || saved === 'npm' || saved === 'yarn' || saved === 'bun') {
      queueMicrotask(() => setPackageManager(saved));
    }
  });

  onMount(() => {
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const copy = event.target.closest('[data-copy]');
      if (copy instanceof HTMLElement) void copyCode(copy);
    };

    const onChange = (event: Event) => {
      if (!(event.target instanceof HTMLSelectElement)) return;
      if (!event.target.matches('[data-pm-select]')) return;
      setPackageManager(event.target.value);
    };

    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);

    const saved = localStorage.getItem('mira.docs.pm');
    if (saved === 'pnpm' || saved === 'npm' || saved === 'yarn' || saved === 'bun') {
      setPackageManager(saved);
    }

    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('change', onChange);
    };
  });
</script>
