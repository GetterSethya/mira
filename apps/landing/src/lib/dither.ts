const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21]
];

const THRESHOLD = BAYER.map((row) => row.map((value) => (value + 0.5) / 64));

const DARK = 10;
const LIGHT = 245;

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function noise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smooth(x - xi);
  const v = smooth(y - yi);

  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);

  const top = a + (b - a) * u;
  const bottom = c + (d - c) * u;

  return top + (bottom - top) * v;
}

function fbm(x: number, y: number, seed: number): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;

  for (let octave = 0; octave < 4; octave += 1) {
    value += amplitude * noise(x * frequency, y * frequency, seed + octave * 19);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2.07;
  }

  return value / total;
}

function field(u: number, v: number, time: number): number {
  const t = time * 0.16;

  const wx = fbm(u * 1.5 + 0.7 + t * 0.4, v * 1.5 - 1.3 - t * 0.3, 17);
  const wy = fbm(u * 1.5 - 2.1 - t * 0.26, v * 1.5 + 3.4 + t * 0.34, 41);

  const wide = fbm(u * 0.9 + 4.2, v * 0.9 - 2.7 + t * 0.18, 131);
  const detail = fbm(
    u * 2.2 + (wx - 0.5) * 3.1 + t * 0.22,
    v * 2.2 + (wy - 0.5) * 3.1 - t * 0.18,
    73
  );

  let value = (detail * 0.58 + wide * 0.42 - 0.5) * 1.78 + 0.47;

  if (value < 0) value = 0;
  else if (value > 1) value = 1;

  return value;
}

export function mountDither(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext('2d');
  if (!context) return () => {};

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let columns = 0;
  let rows = 0;
  let coarseColumns = 0;
  let coarseRows = 0;
  let coarse = new Float32Array(0);
  let image: ImageData | null = null;
  let frame = 0;
  let running = false;
  let onScreen = true;
  let last = 0;
  let clock = 3.2;

  function paint(time: number) {
    if (!image) return;

    const aspect = rows / columns;

    for (let cy = 0; cy < coarseRows; cy += 1) {
      const v = (cy / Math.max(1, coarseRows - 1)) * aspect;
      const rowOffset = cy * coarseColumns;

      for (let cx = 0; cx < coarseColumns; cx += 1) {
        coarse[rowOffset + cx] = field(cx / Math.max(1, coarseColumns - 1), v, time);
      }
    }

    const data = image.data;
    const scaleX = coarseColumns / columns;
    const scaleY = coarseRows / rows;

    for (let y = 0; y < rows; y += 1) {
      const gy = Math.min(coarseRows - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
      const y0 = Math.floor(gy);
      const y1 = Math.min(coarseRows - 1, y0 + 1);
      const fy = gy - y0;
      const band = THRESHOLD[y & 7];

      for (let x = 0; x < columns; x += 1) {
        const gx = Math.min(coarseColumns - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
        const x0 = Math.floor(gx);
        const x1 = Math.min(coarseColumns - 1, x0 + 1);
        const fx = gx - x0;

        const a = coarse[y0 * coarseColumns + x0];
        const b = coarse[y0 * coarseColumns + x1];
        const c = coarse[y1 * coarseColumns + x0];
        const d = coarse[y1 * coarseColumns + x1];

        const top = a + (b - a) * fx;
        const bottom = c + (d - c) * fx;
        const value = top + (bottom - top) * fy;

        const tone = value > band[x & 7] ? LIGHT : DARK;
        const index = (y * columns + x) * 4;

        data[index] = tone;
        data[index + 1] = tone;
        data[index + 2] = tone;
        data[index + 3] = 255;
      }
    }

    context.putImageData(image, 0, 0);
  }

  function measure() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);

    columns = Math.round(Math.min(560, Math.max(240, width / 4)));
    rows = Math.max(2, Math.round((height / width) * columns));

    canvas.width = columns;
    canvas.height = rows;

    image = context.createImageData(columns, rows);

    coarseColumns = Math.max(2, Math.ceil(columns / 2));
    coarseRows = Math.max(2, Math.ceil(rows / 2));
    coarse = new Float32Array(coarseColumns * coarseRows);

    paint(clock);
  }

  function tick(now: number) {
    if (!running) return;
    frame = requestAnimationFrame(tick);

    if (!onScreen) return;
    if (now - last < 33) return;

    const delta = Math.min(0.08, (now - last) / 1000);
    last = now;
    clock += delta;
    paint(clock);
  }

  function start() {
    if (running || reduceMotion.matches) return;
    running = true;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(frame);
  }

  const intersection = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      onScreen = entry ? entry.isIntersecting : true;
      if (onScreen) start();
      else stop();
    },
    { threshold: 0.01 }
  );

  const resizeObserver = new ResizeObserver(() => measure());

  function handleVisibility() {
    if (document.hidden) stop();
    else if (onScreen) start();
  }

  measure();
  start();

  intersection.observe(canvas);
  resizeObserver.observe(canvas);
  document.addEventListener('visibilitychange', handleVisibility);

  return () => {
    stop();
    intersection.disconnect();
    resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', handleVisibility);
  };
}
