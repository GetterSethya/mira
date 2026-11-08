export function reveal(node: HTMLElement, delay = 0) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduced || !('IntersectionObserver' in window)) {
    node.classList.add('is-revealed');
    return;
  }

  node.classList.add('reveal');
  node.style.setProperty('--reveal-delay', `${delay}ms`);

  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      node.classList.add('is-revealed');
      observer.disconnect();
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
  );

  observer.observe(node);

  return {
    destroy() {
      observer.disconnect();
    }
  };
}
