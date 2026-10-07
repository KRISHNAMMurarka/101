/** A closed data interpreter. Source is parsed, never evaluated by a JavaScript engine.
 * Guest values occupy one fixed arena; parser/AST/host dictionaries and Worker RSS are outside that limit.
 * Only scalar closure state is retained. No host object, import, general call or prototype lookup exists.
 */
type Expression =
  | { tag: 'literal'; value: number | boolean | undefined }
  | { tag: 'name'; name: string }
  | { tag: 'member'; name: string; field: string }
  | { tag: 'record'; fields: readonly [string, Expression][] }
  | { tag: 'unary'; operator: string; value: Expression }
  | { tag: 'binary'; operator: string; left: Expression; right: Expression }
  | { tag: 'choose'; condition: Expression; yes: Expression; no: Expression }
  | { tag: 'finite'; value: Expression }
  | { tag: 'bytes'; length: Expression };
type Statement =
  | { tag: 'declare'; names: readonly string[]; value?: Expression; destructure: boolean }
  | { tag: 'assign'; name: string; value: Expression }
  | { tag: 'if'; condition: Expression; yes: readonly Statement[]; no: readonly Statement[] }
  | { tag: 'while'; condition: Expression; body: readonly Statement[] }
  | { tag: 'return'; value?: Expression }
  | { tag: 'throw' };
export interface ComputeProcessorProgram {
  readonly parameter: string; readonly input: string; readonly initialize: readonly Statement[];
  readonly process: readonly Statement[]; readonly reset: readonly Statement[]; readonly globals: readonly string[];
}
export type ComputeProcessorFailure = 'processor-language' | 'memory' | 'timeout' | 'compute' | 'output';
export class ComputeProcessorError extends Error {
  readonly reason: ComputeProcessorFailure;
  constructor(reason: ComputeProcessorFailure) { super(reason); this.reason = reason; }
}
function fail(reason: ComputeProcessorFailure): never { throw new ComputeProcessorError(reason); }
const prohibited = new Set(['__proto__', 'prototype', 'constructor', 'process', 'globalThis', 'global', 'require',
  'import', 'eval', 'Function', 'fetch', 'WebAssembly', 'Buffer', 'Deno', 'window', 'self']);
function name(value: string): string {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(value) || prohibited.has(value)) fail('processor-language');
  return value;
}
interface Token { text: string; string?: boolean }
function tokens(source: string): Token[] {
  const result: Token[] = [];
  let at = 0;
  while (at < source.length) {
    if (/\s/.test(source.charAt(at))) { at++; continue; }
    if (source.startsWith('//', at)) { while (at < source.length && source.charAt(at) !== '\n') at++; continue; }
    if (source.startsWith('/*', at)) { const end = source.indexOf('*/', at + 2); if (end < 0) fail('processor-language'); at = end + 2; continue; }
    const start = at, character = source.charAt(at);
    if (character === '"' || character === "'") {
      at++;
      while (at < source.length && source.charAt(at) !== character) {
        if (source.charAt(at) === '\\' || source.charAt(at) === '\n' || source.charAt(at) === '\r') fail('processor-language');
        at++;
      }
      if (at === source.length || at - start > 512) fail('processor-language');
      result.push({ text: source.slice(start + 1, at++), string: true });
    } else if (/[A-Za-z_$]/.test(character)) {
      at++; while (at < source.length && /[A-Za-z0-9_$]/.test(source.charAt(at))) at++;
      result.push({ text: source.slice(start, at) });
    } else if (/[0-9]/.test(character)) {
      at++; while (at < source.length && /[0-9.]/.test(source.charAt(at))) at++;
      const text = source.slice(start, at);
      if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text) || !Number.isFinite(Number(text))) fail('processor-language');
      result.push({ text });
    } else {
      const operator = ['===', '!==', '>=', '<=', '&&', '||', '==', '!='].find(value => source.startsWith(value, at));
      if (operator) { result.push({ text: operator }); at += operator.length; }
      else { if (!'{}().,;:=?!+-*/<>'.includes(character)) fail('processor-language'); result.push({ text: character }); at++; }
    }
    if (result.length > 4096) fail('processor-language');
  }
  return result;
}
/** Bounded source/AST construction occurs in the parent, before any worker is acquired. */
export function compileComputeProcessor(source: Uint8Array, entrypoint: string): ComputeProcessorProgram {
  if (source.byteLength < 1 || source.byteLength > 256 * 1024) fail('processor-language');
  const input = tokens(new TextDecoder('utf-8', { fatal: true }).decode(source));
  let cursor = 0, nodes = 0, depth = 0;
  const scope = new Map<string, boolean>();
  const peek = () => input[cursor]?.text;
  const take = (value: string) => { if (input[cursor]?.string || peek() !== value) fail('processor-language'); cursor++; };
  const maybe = (value: string) => { if (peek() !== value || input[cursor]?.string) return false; cursor++; return true; };
  const identifier = () => { const token = input[cursor++]; if (!token || token.string) fail('processor-language'); return name(token.text); };
  const declared = (value: string) => { if (!scope.has(value)) fail('processor-language'); return value; };
  function bounded<T>(callback: () => T): T {
    if (++nodes > 4096 || ++depth > 32) fail('processor-language');
    try { return callback(); } finally { depth--; }
  }
  function declare(value: string, mutable: boolean) {
    if (scope.has(value) || scope.size >= 64) fail('processor-language'); scope.set(value, mutable);
  }
  const precedence: Record<string, number> = { '||': 1, '&&': 2, '===': 3, '!==': 3, '>': 4, '<': 4, '>=': 4, '<=': 4, '+': 5, '-': 5, '*': 6, '/': 6 };
  function primary(): Expression {
    return bounded(() => {
      if (maybe('(')) { const value = expression(); take(')'); return value; }
      if (maybe('!')) return { tag: 'unary', operator: '!', value: primary() };
      if (maybe('-')) return { tag: 'unary', operator: '-', value: primary() };
      if (maybe('{')) {
        const fields: [string, Expression][] = [];
        if (!maybe('}')) do {
          const key = identifier(); if (fields.some(([field]) => key === field) || fields.length >= 32) fail('processor-language');
          take(':'); fields.push([key, expression()]);
          if (maybe('}')) break;
          take(','); if (maybe('}')) break;
        } while (cursor < input.length);
        return { tag: 'record', fields };
      }
      if (maybe('new')) { take('Uint8Array'); take('('); const length = expression(); take(')'); return { tag: 'bytes', length }; }
      if (peek() === 'Number') { take('Number'); take('.'); take('isFinite'); take('('); const value = expression(); take(')'); return { tag: 'finite', value }; }
      const token = input[cursor++]; if (!token || token.string) fail('processor-language');
      if (token.text === 'true' || token.text === 'false') return { tag: 'literal', value: token.text === 'true' };
      if (token.text === 'undefined') return { tag: 'literal', value: undefined };
      if (/^[0-9]/.test(token.text)) return { tag: 'literal', value: Number(token.text) };
      const value = declared(name(token.text));
      if (maybe('.')) return { tag: 'member', name: value, field: identifier() };
      return { tag: 'name', name: value };
    });
  }
  function expression(minimum = 0): Expression {
    return bounded(() => {
      let left = primary();
      while (precedence[peek()!] !== undefined && precedence[peek()!]! >= minimum) {
        const operator = input[cursor++]!.text;
        left = { tag: 'binary', operator, left, right: expression(precedence[operator]! + 1) };
      }
      if (minimum === 0 && maybe('?')) { const yes = expression(); take(':'); left = { tag: 'choose', condition: left, yes, no: expression() }; }
      return left;
    });
  }
  function body(): Statement[] {
    take('{'); const result: Statement[] = [];
    while (!maybe('}')) { if (cursor >= input.length) fail('processor-language'); result.push(...statement()); }
    return result;
  }
  function statement(): Statement[] {
    return bounded(() => {
      if (peek() === '{') return body();
      if (peek() === 'const' || peek() === 'let') {
        const mutable = input[cursor++]!.text === 'let', names: string[] = [], destructure = maybe('{');
        if (destructure) { do { names.push(identifier()); } while (maybe(',')); take('}'); }
        else names.push(identifier());
        const value = maybe('=') ? expression() : undefined;
        if ((!mutable || destructure) && !value) fail('processor-language');
        for (const value of names) declare(value, mutable);
        take(';'); return [{ tag: 'declare', names, value, destructure }];
      }
      if (maybe('if')) {
        take('('); const condition = expression(); take(')'); const yes = statement(), no = maybe('else') ? statement() : [];
        return [{ tag: 'if', condition, yes, no }];
      }
      if (maybe('while')) { take('('); const condition = expression(); take(')'); return [{ tag: 'while', condition, body: body() }]; }
      if (maybe('return')) { const value = peek() === ';' ? undefined : expression(); take(';'); return [{ tag: 'return', value }]; }
      if (maybe('throw')) {
        take('new'); take('RangeError'); take('('); if (!input[cursor++]?.string) fail('processor-language'); take(')'); take(';'); return [{ tag: 'throw' }];
      }
      const value = declared(identifier()); if (scope.get(value) !== true) fail('processor-language');
      take('='); const right = expression(); take(';'); return [{ tag: 'assign', name: value, value: right }];
    });
  }
  take('export'); take('function'); if (identifier() !== name(entrypoint)) fail('processor-language');
  take('('); const parameter = identifier(); declare(parameter, false); take(')'); take('{');
  const initialize: Statement[] = [];
  while (peek() !== 'return') { if (cursor >= input.length) fail('processor-language'); initialize.push(...statement()); }
  const globals = [...scope.keys()].filter(value => value !== parameter);
  take('return'); take('{'); take('process'); take('('); const processInput = identifier(); declare(processInput, false); take(')');
  const process = body(); take(',');
  // Process locals cannot be read by reset; restore the factory scope.
  for (const value of [...scope.keys()]) if (value !== parameter && !globals.includes(value)) scope.delete(value);
  take('reset'); take('('); take(')'); const reset = body(); maybe(','); take('}'); take(';'); take('}');
  if (cursor !== input.length) fail('processor-language');
  const program = { parameter, input: processInput, initialize, process, reset, globals };
  // Chained binary expressions build left branches without parser recursion. Bound the actual AST too.
  const pending: { value: unknown; depth: number }[] = [{ value: program, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++count > 16_384 || depth > 40) fail('processor-language');
    if (value !== null && typeof value === 'object') {
      for (const member of Object.values(value)) pending.push({ value: member, depth: depth + 1 });
    }
  }
  return program;
}

// Every cell is 16 bytes. Record metadata/keys and allocated byte payloads also consume the same fixed arena.
class Arena {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  used = 0;
  constructor(limit: number) { this.bytes = new Uint8Array(new ArrayBuffer(limit)); this.view = new DataView(this.bytes.buffer); }
  reserve(length: number): number {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.used) fail('memory');
    const at = this.used; this.used += length; return at;
  }
  scalar(value: number | boolean | undefined): number {
    if (typeof value === 'number' && !Number.isFinite(value)) fail('compute');
    const at = this.reserve(16); this.view.setUint8(at, value === undefined ? 0 : typeof value === 'boolean' ? 1 : 2);
    this.view.setFloat64(at + 8, value === undefined ? 0 : Number(value), true); return at;
  }
  value(at: number): number | boolean | undefined {
    const tag = this.view.getUint8(at), value = this.view.getFloat64(at + 8, true);
    if (tag === 0) return undefined; if (tag === 1) return value === 1; if (tag === 2) return value;
    fail('compute');
  }
  record(fields: readonly [string, number][]): number {
    const at = this.reserve(16), metadata = this.reserve(fields.length * 12);
    this.view.setUint8(at, 3); this.view.setUint32(at + 4, fields.length, true); this.view.setUint32(at + 8, metadata, true);
    for (let index = 0; index < fields.length; index++) {
      const [key, value] = fields[index]!, bytes = new TextEncoder().encode(key), start = this.reserve(bytes.length);
      this.bytes.set(bytes, start); const row = metadata + index * 12;
      this.view.setUint32(row, start, true); this.view.setUint32(row + 4, bytes.length, true); this.view.setUint32(row + 8, value, true);
    }
    return at;
  }
  field(at: number, field: string): number {
    if (this.view.getUint8(at) !== 3) fail('compute');
    const count = this.view.getUint32(at + 4, true), start = this.view.getUint32(at + 8, true);
    for (let index = 0; index < count; index++) {
      const row = start + index * 12, offset = this.view.getUint32(row, true), length = this.view.getUint32(row + 4, true);
      if (new TextDecoder().decode(this.bytes.subarray(offset, offset + length)) === field) return this.view.getUint32(row + 8, true);
    }
    return this.scalar(undefined);
  }
  import(value: unknown, depth = 0): number {
    if (depth > 16) fail('memory');
    if (value === undefined || typeof value === 'number' || typeof value === 'boolean') return this.scalar(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('compute');
    return this.record(Object.entries(value).map(([key, value]) => [name(key), this.import(value, depth + 1)]));
  }
  export(at: number): unknown {
    let encodedBytes = 0, nodes = 0;
    const consume = (bytes: number) => { encodedBytes += bytes; if (encodedBytes > 4096 || ++nodes > 4096) fail('output'); };
    const decode = (at: number, depth: number): unknown => {
      if (depth > 16) fail('output');
      if (this.view.getUint8(at) < 3) {
        const value = this.value(at);
        consume(value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value)).byteLength);
        return value;
      }
      if (this.view.getUint8(at) !== 3) fail('output');
      const result = Object.create(null) as Record<string, unknown>, count = this.view.getUint32(at + 4, true), start = this.view.getUint32(at + 8, true);
      consume(2);
      for (let index = 0; index < count; index++) {
        const row = start + index * 12, offset = this.view.getUint32(row, true), length = this.view.getUint32(row + 4, true);
        const key = new TextDecoder().decode(this.bytes.subarray(offset, offset + length));
        consume(new TextEncoder().encode(JSON.stringify(key)).byteLength + 1 + (index === 0 ? 0 : 1));
        result[key] = decode(this.view.getUint32(row + 8, true), depth + 1);
      }
      return result;
    };
    return decode(at, 0);
  }
  buffer(length: number): number {
    const at = this.reserve(16); this.reserve(length); this.view.setUint8(at, 4); return at;
  }
  copyScalar(from: number, to: number) { this.value(from); this.bytes.copyWithin(to, from, from + 16); }
}
export interface ComputeProcessorInterpreter {
  process(inputs: unknown): unknown; reset(): void; readonly guestMemoryBytes: number;
}
/** There are no host callbacks or objects reachable from an interpreted expression. */
export function createComputeProcessorInterpreter(program: ComputeProcessorProgram, configuration: unknown,
  memoryBytes: number, maxComputeMs: number): ComputeProcessorInterpreter {
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1 || memoryBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(maxComputeMs) || maxComputeMs < 1 || maxComputeMs > 1000) fail('memory');
  const arena = new Arena(memoryBytes), globals = new Map<string, number>();
  for (const key of program.globals) globals.set(key, arena.scalar(undefined));
  const literals = new Map<number | boolean | undefined, number>();
  function constants(value: Expression): void {
    switch (value.tag) {
      case 'literal': if (!literals.has(value.value)) literals.set(value.value, arena.scalar(value.value)); break;
      case 'record': for (const [, expression] of value.fields) constants(expression); break;
      case 'unary': case 'finite': constants(value.value); break;
      case 'bytes': constants(value.length); break;
      case 'binary': constants(value.left); constants(value.right); break;
      case 'choose': constants(value.condition); constants(value.yes); constants(value.no); break;
      case 'name': case 'member': break;
      default: fail('processor-language');
    }
  }
  function statementConstants(values: readonly Statement[]): void {
    for (const value of values) switch (value.tag) {
      case 'declare': case 'return': if (value.value) constants(value.value); break;
      case 'assign': constants(value.value); break;
      case 'if': constants(value.condition); statementConstants(value.yes); statementConstants(value.no); break;
      case 'while': constants(value.condition); statementConstants(value.body); break;
      case 'throw': break;
      default: fail('processor-language');
    }
  }
  statementConstants(program.initialize); statementConstants(program.process); statementConstants(program.reset);
  const base = arena.used;
  let deadline = 0, steps = 0, environment = new Map<string, number>();
  function tick() { if (++steps > 1_000_000 || performance.now() >= deadline) fail('timeout'); }
  function resolve(key: string): number { const at = environment.get(key) ?? globals.get(key); if (at === undefined) fail('compute'); return at; }
  function scalar(at: number) { return arena.value(at); }
  function number(at: number): number { const value = scalar(at); if (typeof value !== 'number') fail('compute'); return value; }
  function expression(value: Expression): number {
    tick();
    switch (value.tag) {
      case 'literal': return literals.get(value.value)!;
      case 'name': return resolve(value.name);
      case 'member': return arena.field(resolve(value.name), value.field);
      case 'record': return arena.record(value.fields.map(([key, value]) => [key, expression(value)]));
      case 'finite': { const valueAt = expression(value.value); return arena.scalar(arena.view.getUint8(valueAt) === 2 && Number.isFinite(number(valueAt))); }
      case 'bytes': return arena.buffer(number(expression(value.length)));
      case 'unary': { const result = expression(value.value); return arena.scalar(value.operator === '!' ? !scalar(result) : -number(result)); }
      case 'choose': return expression(scalar(expression(value.condition)) ? value.yes : value.no);
      case 'binary': {
        const left = expression(value.left);
        if (value.operator === '&&') return scalar(left) ? expression(value.right) : left;
        if (value.operator === '||') return scalar(left) ? left : expression(value.right);
        const right = expression(value.right);
        switch (value.operator) {
          case '===': return arena.scalar(scalar(left) === scalar(right));
          case '!==': return arena.scalar(scalar(left) !== scalar(right));
          case '>': return arena.scalar(number(left) > number(right));
          case '<': return arena.scalar(number(left) < number(right));
          case '>=': return arena.scalar(number(left) >= number(right));
          case '<=': return arena.scalar(number(left) <= number(right));
          case '+': return arena.scalar(number(left) + number(right));
          case '-': return arena.scalar(number(left) - number(right));
          case '*': return arena.scalar(number(left) * number(right));
          case '/': return arena.scalar(number(left) / number(right));
          default: return fail('processor-language');
        }
      }
      default: return fail('processor-language');
    }
  }
  function assign(key: string, at: number) {
    const persistent = globals.get(key);
    if (persistent !== undefined) arena.copyScalar(at, persistent); else environment.set(key, at);
  }
  function statements(values: readonly Statement[]): { returned: true; value: number } | undefined {
    for (const value of values) {
      tick();
      switch (value.tag) {
        case 'declare': {
          const at = value.value ? expression(value.value) : arena.scalar(undefined);
          for (const key of value.names) assign(key, value.destructure ? arena.field(at, key) : at);
          break;
        }
        case 'assign': assign(value.name, expression(value.value)); break;
        case 'if': { const result = statements(scalar(expression(value.condition)) ? value.yes : value.no); if (result) return result; break; }
        case 'while': {
          while (scalar(expression(value.condition))) { const result = statements(value.body); if (result) return result; tick(); }
          break;
        }
        case 'return': return { returned: true, value: value.value ? expression(value.value) : arena.scalar(undefined) };
        case 'throw': return fail('compute');
        default: return fail('processor-language');
      }
    }
    return undefined;
  }
  function begin() { arena.used = base; environment = new Map(); steps = 0; deadline = performance.now() + maxComputeMs; }
  begin(); environment.set(program.parameter, arena.import(configuration)); statements(program.initialize);
  return Object.freeze({ guestMemoryBytes: memoryBytes,
    process(inputs: unknown): unknown {
      begin(); environment.set(program.input, arena.import(inputs));
      const result = statements(program.process); return result ? arena.export(result.value) : undefined;
    },
    reset(): void { begin(); statements(program.reset); },
  });
}
