import { DeviceValidationError, snapshotJson } from './descriptor.ts';

export interface ControlSurfaceStyle {
  readonly id: string; readonly tone: 'normal' | 'muted' | 'caution';
  readonly density: 'comfortable' | 'compact'; readonly motion: 'none' | 'feedback';
}
interface NodeBase { readonly id: string; readonly style: string }
export type SurfaceControl =
  | Readonly<NodeBase & { kind: 'button'; label: string }>
  | Readonly<NodeBase & { kind: 'toggle'; label: string; initial: boolean }>
  | Readonly<NodeBase & { kind: 'slider'; label: string; min: number; max: number; step: number; initial: number }>
  | Readonly<NodeBase & { kind: 'choice'; label: string; options: readonly Readonly<{ value: string; label: string }>[]; initial: string }>;
export type SurfaceLeaf = SurfaceControl | Readonly<NodeBase & { kind: 'text'; text: string }> |
  Readonly<NodeBase & { kind: 'value'; label: string; text: string }>;
export type SurfaceNode = SurfaceLeaf | Readonly<NodeBase & { kind: 'box'; title: string; children: readonly SurfaceLeaf[] }>;
export interface ControlSurface {
  readonly schemaVersion: 1; readonly id: string; readonly title: string; readonly minColumnWidth: number;
  readonly styles: readonly ControlSurfaceStyle[]; readonly nodes: readonly SurfaceNode[];
}

function fail(code: string): never { throw new DeviceValidationError(`surface-${code}`, '$'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('object');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) fail('fields');
}
function text(value: unknown, max = 160): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value ||
    [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) fail('text');
}
function id(value: unknown): void { if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) fail('id'); }
function list(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) fail('count');
  return value;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000000;
function grid(value: number, min: number, step: number): boolean {
  const index = (value - min) / step;
  const nearest = Math.round(index);
  return nearest === 0 ? value === min : Math.abs(index - nearest) <= Number.EPSILON * 8 * Math.max(1, Math.abs(index));
}

/** Inert descriptions only: no scripts, HTML, URLs, resource permission or unrestricted CSS. */
export function parseControlSurface(input: unknown): Readonly<ControlSurface> {
  const root = object(snapshotJson(input));
  if (new TextEncoder().encode(JSON.stringify(root)).length > 32768) fail('bytes');
  exact(root, ['schemaVersion', 'id', 'title', 'minColumnWidth', 'styles', 'nodes']);
  if (root.schemaVersion !== 1) fail('version');
  if (typeof root.id !== 'string' || root.id.length > 128 || !/^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(root.id)) fail('id');
  text(root.title);
  if (!finite(root.minColumnWidth) || root.minColumnWidth < 160 || root.minColumnWidth > 480) fail('layout');
  const styles = new Set<string>();
  for (const input of list(root.styles, 8)) {
    const style = object(input); exact(style, ['id', 'tone', 'density', 'motion']); id(style.id);
    if (styles.has(style.id as string) || !['normal', 'muted', 'caution'].includes(style.tone as string) ||
      !['comfortable', 'compact'].includes(style.density as string) || !['none', 'feedback'].includes(style.motion as string)) fail('style');
    styles.add(style.id as string);
  }
  const ids = new Set<string>(); let count = 0;
  function node(input: unknown, boxed = false): void {
    const value = object(input); id(value.id);
    if (++count > 64 || ids.has(value.id as string)) fail('count');
    ids.add(value.id as string);
    if (!styles.has(value.style as string)) fail('style-reference');
    const base = ['id', 'kind', 'style'];
    if (value.kind === 'box') {
      if (boxed) fail('box-depth');
      exact(value, [...base, 'title', 'children']); text(value.title);
      for (const child of list(value.children, 32)) node(child, true);
    } else if (value.kind === 'text') { exact(value, [...base, 'text']); text(value.text); }
    else if (value.kind === 'value') { exact(value, [...base, 'label', 'text']); text(value.label); text(value.text); }
    else if (value.kind === 'button') { exact(value, [...base, 'label']); text(value.label); }
    else if (value.kind === 'toggle') {
      exact(value, [...base, 'label', 'initial']); text(value.label); if (typeof value.initial !== 'boolean') fail('value');
    } else if (value.kind === 'slider') {
      exact(value, [...base, 'label', 'min', 'max', 'step', 'initial']); text(value.label);
      if (!finite(value.min) || !finite(value.max) || !finite(value.step) || !finite(value.initial) ||
        value.min >= value.max || value.step <= 0 || value.step > value.max - value.min || (value.max - value.min) / value.step > 10000 ||
        value.initial < value.min || value.initial > value.max || !grid(value.max, value.min, value.step) || !grid(value.initial, value.min, value.step)) fail('slider-grid');
    } else if (value.kind === 'choice') {
      exact(value, [...base, 'label', 'options', 'initial']); text(value.label);
      const values = new Set<string>();
      for (const input of list(value.options, 16)) {
        const option = object(input); exact(option, ['value', 'label']); text(option.value, 64); text(option.label, 80);
        if (values.has(option.value as string)) fail('choice'); values.add(option.value as string);
      }
      if (!values.has(value.initial as string)) fail('choice');
    } else fail('kind');
  }
  for (const input of list(root.nodes, 32)) node(input);
  return root as unknown as Readonly<ControlSurface>;
}

/** A bounded container measurement changes grid columns, never document/focus order. */
export function surfaceColumnCount(width: number, minColumnWidth: number): number {
  if (!finite(width) || !finite(minColumnWidth) || minColumnWidth < 160 || minColumnWidth > 480) return 1;
  return Math.max(1, Math.min(4, Math.floor((width + 16) / (minColumnWidth + 16))));
}
export function surfaceControlValueValid(node: SurfaceControl, value: unknown): value is boolean | number | string {
  if (node.kind === 'button') return value === true;
  if (node.kind === 'toggle') return typeof value === 'boolean';
  if (node.kind === 'choice') return typeof value === 'string' && node.options.some(option => option.value === value);
  return finite(value) && value >= node.min && value <= node.max && grid(value, node.min, node.step);
}
