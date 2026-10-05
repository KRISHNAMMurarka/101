import type { ApplicationViewHandle, ApplicationViews, DeliveryContext, Observation } from '@101/device-runtime';
import type { SignalValue } from '@101/device-model';

export interface ApplicationCanvasGeometry { readonly width: number; readonly height: number; readonly pixelRatio: number }
export interface ApplicationCanvasView {
  readonly ok: boolean;
  readonly reason?: 'unavailable' | 'in-use' | 'denied';
  renew(): boolean;
  stop(): void;
}
export interface ApplicationCanvasOptions {
  readonly canvas: HTMLCanvasElement; readonly views: ApplicationViews;
  readonly viewId: string; readonly outputId: string; readonly principalId: string; readonly label: string;
  /** Trusted synchronous renderer, drawing to a private staging canvas before the current grant is rechecked. */
  draw(context: CanvasRenderingContext2D, value: SignalValue, geometry: ApplicationCanvasGeometry, delivery: DeliveryContext): void;
}

const owners = new WeakMap<HTMLCanvasElement, object>();
const no = (reason: NonNullable<ApplicationCanvasView['reason']>): ApplicationCanvasView => Object.freeze({ ok: false, reason, renew: () => false, stop() {} });

/** One independently authorized local Canvas2D output; no simulation, timer or resource grant is created by the renderer. */
export function mountApplicationViewCanvas(options: ApplicationCanvasOptions): ApplicationCanvasView {
  const { canvas, views, viewId, outputId, principalId, label, draw } = options;
  const window = canvas?.ownerDocument?.defaultView;
  if (!window || typeof draw !== 'function' || typeof label !== 'string' || label.length < 1 || label.length > 256 ||
      !window.ResizeObserver || !window.requestAnimationFrame || !window.cancelAnimationFrame) return no('unavailable');
  if (owners.has(canvas)) return no('in-use');
  const owner = {}; owners.set(canvas, owner);
  let screen: CanvasRenderingContext2D | null, staging: HTMLCanvasElement, paint: CanvasRenderingContext2D | null;
  try { screen = canvas.getContext('2d'); staging = canvas.ownerDocument.createElement('canvas'); paint = staging.getContext('2d'); }
  catch { owners.delete(canvas); return no('unavailable'); }
  if (!screen || !paint) { owners.delete(canvas); return no('unavailable'); }
  let stopped = false, handle: ApplicationViewHandle | undefined, observer: ResizeObserver | undefined;
  let animation: number | undefined, latest: { observation: Observation; delivery: DeliveryContext } | undefined;
  let width = 1, height = 1;
  const previousLabel = canvas.getAttribute('aria-label'), previousRole = canvas.getAttribute('role');
  function clear(): void { screen!.clearRect(0, 0, canvas.width, canvas.height); latest = undefined; }
  function close(): void {
    if (stopped) return;
    stopped = true;
    observer?.disconnect(); observer = undefined;
    if (animation !== undefined) window!.cancelAnimationFrame(animation);
    animation = undefined; clear(); staging.width = 1; staging.height = 1;
    if (owners.get(canvas) === owner) {
      owners.delete(canvas);
      if (previousLabel === null) canvas.removeAttribute('aria-label'); else canvas.setAttribute('aria-label', previousLabel);
      if (previousRole === null) canvas.removeAttribute('role'); else canvas.setAttribute('role', previousRole);
    }
  }
  function render(): void {
    const candidate = latest;
    if (stopped || !candidate || owners.get(canvas) !== owner || !candidate.delivery.isCurrent() || candidate.delivery.signal.aborted) return;
    const pixelRatio = Math.min(2, Math.max(1, window!.devicePixelRatio || 1));
    const requestedWidth = Math.max(1, Math.min(4096, width)), requestedHeight = Math.max(1, Math.min(4096, height));
    const scale = Math.min(pixelRatio, Math.sqrt(1048576 / (requestedWidth * requestedHeight)));
    const w = Math.max(1, Math.floor(requestedWidth * scale)), h = Math.max(1, Math.floor(requestedHeight * scale));
    if (staging.width !== w) staging.width = w;
    if (staging.height !== h) staging.height = h;
    paint!.resetTransform(); paint!.clearRect(0, 0, w, h); paint!.save(); paint!.scale(w / requestedWidth, h / requestedHeight);
    try {
      const returned: unknown = draw(paint!, candidate.observation.value, Object.freeze({ width: requestedWidth, height: requestedHeight, pixelRatio: scale }), candidate.delivery);
      if (returned !== undefined) {
        if (returned instanceof Promise) void returned.catch(() => {});
        throw new TypeError('The renderer must finish synchronously');
      }
    }
    catch { close(); handle?.stop(); return; }
    finally { paint!.restore(); }
    if (stopped || latest !== candidate || !candidate.delivery.isCurrent() || candidate.delivery.signal.aborted || owners.get(canvas) !== owner) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    screen!.resetTransform(); screen!.clearRect(0, 0, w, h); screen!.drawImage(staging, 0, 0);
  }
  function measure(w: number, h: number): void {
    if (stopped || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
    width = w; height = h;
    if (animation === undefined) animation = window!.requestAnimationFrame(() => { animation = undefined; render(); });
  }
  try {
    const attached = views.attach({ viewId, outputId, principalId,
      apply(observation, delivery) { if (stopped || delivery.signal.aborted || !delivery.isCurrent()) return; latest = { observation, delivery }; render(); },
      release: close });
    if (!attached.ok || stopped) { close(); if (attached.ok) attached.value.stop(); return no('denied'); }
    handle = attached.value;
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', label);
    width = Math.max(1, canvas.clientWidth); height = Math.max(1, canvas.clientHeight);
    observer = new window.ResizeObserver(entries => {
      const entry = entries.find(item => item.target === canvas); if (entry) measure(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(canvas);
    return Object.freeze({ ok: true, renew: () => !stopped && handle!.renew(), stop() { close(); handle!.stop(); } });
  } catch { close(); handle?.stop(); return no('unavailable'); }
}
