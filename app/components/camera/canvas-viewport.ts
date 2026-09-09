export interface CanvasViewport {
  width: number;
  height: number;
  ratio: number;
}

/** Measure on resize, never in the inference loop. Only changed backing dimensions allocate. */
export function observeCanvasViewport(canvas: HTMLCanvasElement, onResize: (viewport: CanvasViewport) => void) {
  const resize = (width: number, height: number) => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelsWide = Math.max(1, Math.round(width * ratio));
    const pixelsHigh = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
    if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
    onResize({ width, height, ratio });
  };
  const measure = () => {
    const bounds = canvas.getBoundingClientRect();
    resize(bounds.width, bounds.height);
  };
  measure();
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver((entries) => {
    const entry = entries.find((candidate) => candidate.target === canvas);
    if (entry) resize(entry.contentRect.width, entry.contentRect.height);
  });
  observer?.observe(canvas);
  window.addEventListener("resize", measure);
  return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
}
