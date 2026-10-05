import { parseControlSurface, surfaceColumnCount } from '@101/device-model';
import type { SurfaceControl, SurfaceLeaf, SurfaceNode } from '@101/device-model';
import { createControlInput } from './control-input.ts';
import type { ControlInputState, SurfaceControlCallback } from './control-input.ts';

export interface ControlSurfaceOptions {
  readonly container: HTMLElement; readonly description: unknown;
  /** Explicit host code; authorization and physical effect evidence remain with that host. */
  readonly onControl: SurfaceControlCallback; readonly callbackTimeoutMs?: number;
}
export interface MountedControlSurface {
  readonly element: HTMLElement;
  setEnabled(id: string, enabled: boolean): boolean;
  setValue(id: string, value: unknown): boolean;
  setText(id: string, text: string): boolean;
  state(): Readonly<{ closed: boolean; columns: number; controls: number }>;
  close(): void;
}
export type { SurfaceControlEvent, SurfaceControlContext, SurfaceControlCallback } from './control-input.ts';

let instance = 0;
const CSS = `.sdk-control-surface{--sdk-surface-bg:#fff;--sdk-surface-text:#171717;--sdk-surface-muted:#525252;--sdk-surface-line:#777;--sdk-surface-feedback:#ededed;color:var(--sdk-surface-text);background:var(--sdk-surface-bg);font:16px/1.5 system-ui,sans-serif;padding:16px;min-width:0;box-sizing:border-box}
.sdk-control-surface *{box-sizing:border-box;min-width:0}.sdk-control-surface h2,.sdk-control-surface h3,.sdk-control-surface p{margin:0;overflow-wrap:anywhere}
.sdk-control-surface h2{font-size:1.5em;line-height:1.3;margin-bottom:16px}.sdk-surface-grid{display:grid;gap:16px}.sdk-surface-box{border:1px solid var(--sdk-surface-line);padding:16px;display:flex;flex-direction:column;gap:16px}.sdk-surface-box h3{font-size:1.125em}
.sdk-surface-leaf{display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere}.sdk-surface-leaf label{font-weight:600}.sdk-control-surface button,.sdk-control-surface select,.sdk-control-surface input{font:inherit;color:inherit;accent-color:var(--sdk-surface-text);min-height:44px;min-width:44px;width:100%;border:1px solid var(--sdk-surface-line);background:var(--sdk-surface-bg);border-radius:0;padding:8px;white-space:normal}
.sdk-control-surface button{cursor:pointer}.sdk-control-surface button:hover:not(:disabled),.sdk-control-surface button:active:not(:disabled){background:var(--sdk-surface-feedback)}.sdk-control-surface button[aria-pressed=true]{background:var(--sdk-surface-text);color:var(--sdk-surface-bg)}
.sdk-control-surface select{appearance:none;padding-right:44px}.sdk-surface-choice{position:relative}.sdk-surface-choice-arrow{position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:24px;line-height:1;pointer-events:none}
.sdk-control-surface input[type=range]{appearance:none;padding:0 8px}.sdk-control-surface input[type=range]::-webkit-slider-runnable-track{height:4px;background:var(--sdk-surface-line)}.sdk-control-surface input[type=range]::-webkit-slider-thumb{appearance:none;width:24px;height:24px;margin-top:-10px;border:2px solid var(--sdk-surface-bg);border-radius:50%;background:var(--sdk-surface-text)}
.sdk-control-surface input[type=range]::-moz-range-track{height:4px;background:var(--sdk-surface-line)}.sdk-control-surface input[type=range]::-moz-range-thumb{width:24px;height:24px;border:2px solid var(--sdk-surface-bg);border-radius:50%;background:var(--sdk-surface-text)}
.sdk-control-surface :focus-visible{outline:3px solid currentColor;outline-offset:3px}.sdk-control-surface :disabled{cursor:default;border-style:dashed}.sdk-surface-status{font-size:.875em;min-height:1.5em;color:var(--sdk-surface-muted)}.sdk-surface-muted{color:var(--sdk-surface-muted)}.sdk-surface-caution{border:1px dashed var(--sdk-surface-line);padding:8px}.sdk-surface-compact{gap:8px;padding:8px}.sdk-surface-feedback button{transition:background-color 120ms ease,color 120ms ease}
@media(prefers-color-scheme:dark){.sdk-control-surface{--sdk-surface-bg:#171717;--sdk-surface-text:#fff;--sdk-surface-muted:#bbb;--sdk-surface-line:#999;--sdk-surface-feedback:#333}}
@media(prefers-reduced-motion:reduce){.sdk-control-surface *{transition:none!important;animation:none!important}}
@media(forced-colors:active){.sdk-control-surface{--sdk-surface-bg:Canvas;--sdk-surface-text:CanvasText;--sdk-surface-muted:CanvasText;--sdk-surface-line:CanvasText;--sdk-surface-feedback:Canvas}}
`;
const messages: Record<ControlInputState['status'], string> = {
  ready: 'Ready.', sending: 'Sending input…', sent: 'Input sent.', failed: 'Input could not be sent. Try again.',
  unavailable: 'Unavailable. Enable this control after access is approved.',
};

/** Render bounded semantic controls without obtaining device access or granting a route. */
export function mountControlSurface(options: ControlSurfaceOptions): MountedControlSurface {
  const description = parseControlSurface(options.description);
  const document = options.container?.ownerDocument;
  const window = document?.defaultView as (Window & typeof globalThis) | null;
  if (!document || !window || typeof options.container.append !== 'function') throw new TypeError('Control surface container unavailable');
  const root = document.createElement('section'); root.className = 'sdk-control-surface';
  const prefix = `sdk-surface-${++instance}`; root.setAttribute('aria-labelledby', `${prefix}-title`);
  const css = document.createElement('style'); css.textContent = CSS; root.append(css);
  const title = document.createElement('h2'); title.id = `${prefix}-title`; title.textContent = description.title; root.append(title);
  const grid = document.createElement('div'); grid.className = 'sdk-surface-grid'; root.append(grid);
  const styles = new Map(description.styles.map(style => [style.id, style]));
  const controls: SurfaceControl[] = [], outputs = new Map<string, HTMLElement>();
  const widgets = new Map<string, { node: SurfaceControl; widget: HTMLButtonElement | HTMLInputElement | HTMLSelectElement; status: HTMLElement; value?: HTMLOutputElement }>();
  const cleanups: (() => void)[] = [];
  let closed = false, columns = 1, frame: number | undefined, measuredWidth = 0;
  function decorate(element: HTMLElement, styleId: string): void {
    const style = styles.get(styleId)!;
    element.classList.add(`sdk-surface-${style.tone}`, `sdk-surface-${style.density}`);
    if (style.motion === 'feedback') element.classList.add('sdk-surface-feedback');
  }
  function leaf(node: SurfaceLeaf, parent: HTMLElement): void {
    const wrapper = document.createElement('div'); wrapper.className = 'sdk-surface-leaf'; decorate(wrapper, node.style); parent.append(wrapper);
    if (node.kind === 'text') { const text = document.createElement('p'); text.textContent = node.text; wrapper.append(text); return; }
    if (node.kind === 'value') {
      const label = document.createElement('strong'); label.textContent = node.label; label.id = `${prefix}-readout-${node.id}-label`;
      const value = document.createElement('output'); value.setAttribute('aria-labelledby', label.id);
      value.textContent = node.text; outputs.set(node.id, value); wrapper.append(label, value); return;
    }
    controls.push(node);
    const isButton = node.kind === 'button' || node.kind === 'toggle';
    const widget = document.createElement(isButton ? 'button' : node.kind === 'slider' ? 'input' : 'select') as HTMLButtonElement | HTMLInputElement | HTMLSelectElement;
    widget.id = `${prefix}-control-${node.id}`;
    if (isButton) { (widget as HTMLButtonElement).type = 'button'; widget.textContent = node.label; }
    else { const label = document.createElement('label'); label.htmlFor = widget.id; label.textContent = node.label; wrapper.append(label); }
    let value: HTMLOutputElement | undefined;
    if (node.kind === 'slider') {
      const slider = widget as HTMLInputElement; slider.type = 'range'; slider.min = String(node.min); slider.max = String(node.max); slider.step = String(node.step);
      value = document.createElement('output'); value.htmlFor = widget.id; value.setAttribute('aria-label', `${node.label} value`);
    } else if (node.kind === 'choice') for (const option of node.options) {
      const item = document.createElement('option'); item.value = option.value; item.textContent = option.label; widget.append(item);
    }
    const status = document.createElement('p'); status.id = `${prefix}-status-${node.id}`; status.className = 'sdk-surface-status';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); widget.setAttribute('aria-describedby', status.id);
    if (node.kind === 'choice') {
      const row = document.createElement('div'); row.className = 'sdk-surface-choice';
      const arrow = document.createElement('span'); arrow.className = 'sdk-surface-choice-arrow';
      arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '▾'; row.append(widget, arrow); wrapper.append(row);
    } else wrapper.append(widget);
    if (value) wrapper.append(value); wrapper.append(status);
    widgets.set(node.id, { node, widget, status, value });
    const event = isButton ? 'click' : node.kind === 'slider' ? 'input' : 'change';
    const emit = () => {
      const next = node.kind === 'button' ? true : node.kind === 'toggle' ? !input.state(node.id)?.value
        : node.kind === 'slider' ? (widget as HTMLInputElement).valueAsNumber : widget.value;
      input.send(node.id, next);
      paint();
    };
    widget.addEventListener(event, emit); cleanups.push(() => widget.removeEventListener(event, emit));
  }
  function render(node: SurfaceNode): void {
    if (node.kind !== 'box') { leaf(node, grid); return; }
    const box = document.createElement('section'); box.className = 'sdk-surface-box'; decorate(box, node.style);
    const heading = document.createElement('h3'); heading.id = `${prefix}-box-${node.id}`; heading.textContent = node.title;
    box.setAttribute('aria-labelledby', heading.id); box.append(heading); grid.append(box);
    for (const child of node.children) leaf(child, box);
  }
  for (const node of description.nodes) render(node);
  const input = createControlInput(controls, options.onControl, options.callbackTimeoutMs);
  function paint(): void {
    if (closed) return;
    for (const [id, { node, widget, status, value }] of widgets) {
      const state = input.state(id)!; widget.disabled = !state.enabled;
      widget.setAttribute('aria-busy', String(state.pending));
      widget.setAttribute('aria-disabled', String(!state.enabled || node.kind === 'button' && state.pending));
      if (node.kind === 'toggle') widget.setAttribute('aria-pressed', String(state.value));
      else if (node.kind === 'slider' || node.kind === 'choice') widget.value = String(state.value);
      if (value) value.value = String(state.value);
      status.textContent = messages[state.status];
    }
  }
  const unsubscribe = input.subscribe(paint); paint(); options.container.append(root);
  function measure(width = grid.getBoundingClientRect().width): void {
    if (closed) return;
    const next = Math.min(description.nodes.length, surfaceColumnCount(width, description.minColumnWidth));
    if (columns === next && grid.style.gridTemplateColumns) return;
    columns = next;
    grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`; root.dataset.columns = String(columns);
  }
  const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(entries => {
    const entry = entries.find(entry => entry.target === grid); if (!entry || closed) return;
    measuredWidth = entry.contentRect.width;
    if (frame === undefined) frame = window.requestAnimationFrame(() => { frame = undefined; measure(measuredWidth); });
  }) : undefined;
  const onResize = () => measure(); observer?.observe(grid);
  if (!observer) { window.addEventListener('resize', onResize); cleanups.push(() => window.removeEventListener('resize', onResize)); }
  measure();
  return Object.freeze<MountedControlSurface>({
    element: root,
    setEnabled: (id, enabled) => input.enable(id, enabled), setValue: (id, value) => input.setValue(id, value),
    setText(id, text) {
      const target = outputs.get(id);
      if (closed || !target || typeof text !== 'string' || text.length < 1 || text.length > 160 ||
        [...text].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
      target.textContent = text; return true;
    },
    state: () => Object.freeze({ closed, columns, controls: controls.length }),
    close() {
      if (closed) return; closed = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame); frame = undefined;
      observer?.disconnect(); unsubscribe(); for (const cleanup of cleanups) cleanup(); input.close(); root.remove();
      widgets.clear(); outputs.clear(); controls.length = 0;
    },
  });
}
