import { DeviceValidationError, snapshotJson } from './descriptor.ts';
import type { JsonObject } from './descriptor.ts';

export interface RecipeEndpoint { readonly node: string; readonly port: string }
export interface RecipeResource {
  readonly id: string; readonly direction: 'source' | 'sink'; readonly semantic: string;
  readonly schemaVersion: number; readonly required: boolean;
}
export interface RecipeProcessor {
  readonly id: string;
  readonly manifest: Readonly<{ id: string; version: string; codeSha256: string }>;
  readonly configuration: Readonly<JsonObject>;
}
export interface RecipeRoute {
  readonly id: string; readonly from: Readonly<RecipeEndpoint>; readonly to: Readonly<RecipeEndpoint>;
  readonly required: boolean;
}
export interface RecipePermission {
  readonly route: string; readonly side: 'from' | 'to';
  readonly operation: 'read' | 'subscribe' | 'write' | 'invoke';
  readonly owner: 'required'; readonly purpose: string;
}
export interface RecipeStyle {
  readonly id: string; readonly tone: 'normal' | 'muted' | 'caution';
  readonly density: 'comfortable' | 'compact';
}
export type RecipeComponent = Readonly<{ id: string; kind: 'text'; text: string; style: string }> |
  Readonly<{ id: string; kind: 'value'; label: string; from: Readonly<RecipeEndpoint>; style: string }> |
  Readonly<{ id: string; kind: 'action'; label: string; route: string; style: string }>;
export interface RecipeSurface {
  readonly id: string; readonly title: string; readonly components: readonly RecipeComponent[];
}
export interface Recipe {
  readonly schemaVersion: 1; readonly id: string; readonly version: string;
  readonly resources: readonly RecipeResource[]; readonly processors: readonly RecipeProcessor[];
  readonly routes: readonly RecipeRoute[]; readonly permissions: readonly RecipePermission[];
  readonly styles: readonly RecipeStyle[]; readonly surfaces: readonly RecipeSurface[];
}

function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('recipe-object', path);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[], path: string): void {
  if (Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) fail('recipe-fields', path);
}
function list(value: unknown, path: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail('recipe-list', path);
  return value as readonly unknown[];
}
function name(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-z][a-z0-9-]*$/.test(value)) fail('recipe-name', path);
  return value as string;
}
function namespace(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > 128 ||
      !/^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) fail('recipe-namespace', path);
  return value as string;
}
function title(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 160 || value.trim() !== value ||
      Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail('recipe-text', path);
  return value as string;
}
function version(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length > 64 ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) fail('recipe-version', path);
}
function positive(value: unknown, path: string, max: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) fail('recipe-number', path);
}
function endpoint(value: unknown, path: string): RecipeEndpoint {
  const entry = object(value, path);
  exact(entry, ['node', 'port'], path);
  name(entry.node, `${path}.node`); name(entry.port, `${path}.port`);
  return entry as unknown as RecipeEndpoint;
}
function unique(values: readonly { readonly id: string }[], path: string): void {
  if (new Set(values.map(value => value.id)).size !== values.length) fail('recipe-duplicate', path);
}

/** Parse an inert recipe declaration; resolution, consent and execution stay with the host. */
export function parseRecipe(input: unknown): Readonly<Recipe> {
  const source = object(snapshotJson(input), '$');
  exact(source, ['schemaVersion', 'id', 'version', 'resources', 'processors', 'routes',
    'permissions', 'styles', 'surfaces'], '$');
  if (source.schemaVersion !== 1) fail('recipe-schema-version', '$.schemaVersion');
  namespace(source.id, '$.id'); version(source.version, '$.version');
  const resources = list(source.resources, '$.resources', 1, 16).map((item, index) => {
    const path = `$.resources[${index}]`, value = object(item, path);
    exact(value, ['id', 'direction', 'semantic', 'schemaVersion', 'required'], path);
    name(value.id, `${path}.id`); namespace(value.semantic, `${path}.semantic`);
    if (value.direction !== 'source' && value.direction !== 'sink') fail('recipe-direction', `${path}.direction`);
    positive(value.schemaVersion, `${path}.schemaVersion`, 65535);
    if (typeof value.required !== 'boolean') fail('recipe-required', `${path}.required`);
    return value as unknown as RecipeResource;
  });
  const processors = list(source.processors, '$.processors', 0, 16).map((item, index) => {
    const path = `$.processors[${index}]`, value = object(item, path);
    exact(value, ['id', 'manifest', 'configuration'], path); name(value.id, `${path}.id`);
    const manifest = object(value.manifest, `${path}.manifest`);
    exact(manifest, ['id', 'version', 'codeSha256'], `${path}.manifest`);
    namespace(manifest.id, `${path}.manifest.id`); version(manifest.version, `${path}.manifest.version`);
    if (typeof manifest.codeSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.codeSha256))
      fail('recipe-processor-pin', `${path}.manifest.codeSha256`);
    object(value.configuration, `${path}.configuration`);
    return value as unknown as RecipeProcessor;
  });
  unique([...resources, ...processors], '$.resources');
  const nodes = new Map<string, RecipeResource | RecipeProcessor>([...resources, ...processors].map(item => [item.id, item]));
  const routes = list(source.routes, '$.routes', 1, 32).map((item, index) => {
    const path = `$.routes[${index}]`, value = object(item, path);
    exact(value, ['id', 'from', 'to', 'required'], path); name(value.id, `${path}.id`);
    const from = endpoint(value.from, `${path}.from`), to = endpoint(value.to, `${path}.to`);
    const left = nodes.get(from.node), right = nodes.get(to.node);
    if (!left || !right) fail('recipe-route-node', path);
    if ('direction' in left && (left.direction !== 'source' || from.port !== 'value')) fail('recipe-route-source', `${path}.from`);
    if ('direction' in right && (right.direction !== 'sink' || to.port !== 'value')) fail('recipe-route-sink', `${path}.to`);
    if (from.node === to.node) fail('recipe-route-loop', path);
    if (typeof value.required !== 'boolean') fail('recipe-required', `${path}.required`);
    return value as unknown as RecipeRoute;
  });
  unique(routes, '$.routes');
  const routeIds = new Set(routes.map(route => route.id));
  const edges = routes.map(route => `${route.from.node}\0${route.from.port}\0${route.to.node}\0${route.to.port}`);
  if (new Set(edges).size !== edges.length) fail('recipe-duplicate-route', '$.routes');
  const expectedPermissions = new Set(routes.flatMap(route => (['from', 'to'] as const)
    .filter(side => 'direction' in nodes.get(route[side].node)!)
    .map(side => `${route.id}\0${side}`)));
  list(source.permissions, '$.permissions', 1, 64).forEach((item, index) => {
    const path = `$.permissions[${index}]`, value = object(item, path);
    exact(value, ['route', 'side', 'operation', 'owner', 'purpose'], path);
    const route = name(value.route, `${path}.route`);
    if (!routeIds.has(route) || value.side !== 'from' && value.side !== 'to') fail('recipe-permission-route', path);
    const key = `${route}\0${value.side}`;
    if (!expectedPermissions.delete(key)) fail('recipe-permission-leg', path);
    if (value.side === 'from' ? value.operation !== 'read' && value.operation !== 'subscribe'
      : value.operation !== 'write' && value.operation !== 'invoke') fail('recipe-operation', `${path}.operation`);
    if (value.owner !== 'required') fail('recipe-permission-owner', `${path}.owner`);
    title(value.purpose, `${path}.purpose`);
  });
  if (expectedPermissions.size) fail('recipe-missing-permission', '$.permissions');
  const styles = list(source.styles, '$.styles', 1, 8).map((item, index) => {
    const path = `$.styles[${index}]`, value = object(item, path);
    exact(value, ['id', 'tone', 'density'], path); name(value.id, `${path}.id`);
    if (value.tone !== 'normal' && value.tone !== 'muted' && value.tone !== 'caution') fail('recipe-tone', `${path}.tone`);
    if (value.density !== 'comfortable' && value.density !== 'compact') fail('recipe-density', `${path}.density`);
    return value as unknown as RecipeStyle;
  });
  unique(styles, '$.styles');
  const styleIds = new Set(styles.map(style => style.id));
  const surfaces = list(source.surfaces, '$.surfaces', 1, 4).map((item, index) => {
    const path = `$.surfaces[${index}]`, value = object(item, path);
    exact(value, ['id', 'title', 'components'], path); name(value.id, `${path}.id`); title(value.title, `${path}.title`);
    const components = list(value.components, `${path}.components`, 1, 32).map((item, position) => {
      const at = `${path}.components[${position}]`, component = object(item, at);
      if (component.kind === 'text') {
        exact(component, ['id', 'kind', 'text', 'style'], at); title(component.text, `${at}.text`);
      } else if (component.kind === 'value') {
        exact(component, ['id', 'kind', 'label', 'from', 'style'], at); title(component.label, `${at}.label`);
        const from = endpoint(component.from, `${at}.from`), node = nodes.get(from.node);
        if (!node || 'direction' in node && (node.direction !== 'source' || from.port !== 'value'))
          fail('recipe-value-source', `${at}.from`);
      } else if (component.kind === 'action') {
        exact(component, ['id', 'kind', 'label', 'route', 'style'], at); title(component.label, `${at}.label`);
        const route = routes.find(route => route.id === component.route);
        if (!route || !('direction' in nodes.get(route.to.node)!)) fail('recipe-action-route', `${at}.route`);
      } else fail('recipe-component-kind', `${at}.kind`);
      name(component.id, `${at}.id`);
      if (!styleIds.has(component.style as string)) fail('recipe-component-style', `${at}.style`);
      return component as unknown as RecipeComponent;
    });
    unique(components, `${path}.components`);
    return value as unknown as RecipeSurface;
  });
  unique(surfaces, '$.surfaces');
  return source as unknown as Readonly<Recipe>;
}
