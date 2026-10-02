import { DeviceValidationError, parseValueSchema, snapshotJson } from './descriptor.ts';
import { parseSignalValue } from './sample.ts';
import type { SignalValue, SpatialAxis, SpatialFrame, ValueSchema } from './descriptor.ts';

type PoseSchema = Extract<ValueSchema, { type: 'pose' }>;
type TransformSchema = Extract<ValueSchema, { type: 'transform' }>;
type Vector = readonly [number, number, number];
type Matrix = readonly [Vector, Vector, Vector];
interface Quaternion { readonly x: number; readonly y: number; readonly z: number; readonly w: number }
interface Position { readonly x: number; readonly y: number; readonly z: number }
interface Pose { readonly position: Position; readonly orientation: Quaternion }
interface Transform { readonly translation: Position; readonly rotation: Quaternion; readonly mirrored: boolean }

export interface SpatialPoseConverterOptions {
  readonly decimalPlaces: number;
  readonly maxAbsoluteError: number;
  readonly transform?: { readonly schema: TransformSchema; readonly value: Transform };
}
export interface SpatialConversionMetadata {
  readonly sourceFrame: SpatialFrame;
  readonly targetFrame: SpatialFrame;
  readonly unitScale: number;
  readonly axisMap: Matrix;
  readonly mirrored: boolean;
  readonly decimalPlaces: number;
  readonly maxAbsoluteError: number;
  readonly positionErrorBound: number;
  readonly transformed: boolean;
}
export interface SpatialPoseConverter {
  readonly metadata: SpatialConversionMetadata;
  convert(input: unknown): SignalValue;
}

const AXES: Readonly<Record<SpatialAxis, Vector>> = Object.freeze({
  right: [1, 0, 0], left: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
  forward: [0, 0, 1], backward: [0, 0, -1],
});
const UNIT_SCALE = { m: 1, cm: 0.01, mm: 0.001 } as const;

function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function dot(a: Vector, b: Vector): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function multiply(a: Matrix, b: Matrix): Matrix {
  const row = (vector: Vector): Vector => [
    vector[0] * b[0][0] + vector[1] * b[1][0] + vector[2] * b[2][0],
    vector[0] * b[0][1] + vector[1] * b[1][1] + vector[2] * b[2][1],
    vector[0] * b[0][2] + vector[1] * b[1][2] + vector[2] * b[2][2],
  ];
  return [row(a[0]), row(a[1]), row(a[2])];
}
function product(matrix: Matrix, vector: Vector): Vector { return matrix.map((row) => dot(row, vector)) as unknown as Vector; }
function axesMap(source: SpatialFrame, target: SpatialFrame): Matrix {
  return target.axes.map((axis) => source.axes.map((member) => dot(AXES[axis], AXES[member])) as unknown as Vector) as unknown as Matrix;
}
function rotationMatrix(q: Quaternion): Matrix {
  const { x, y, z, w } = q;
  const coefficient = 2 / (x * x + y * y + z * z + w * w);
  return [
    [1 - coefficient * (y * y + z * z), coefficient * (x * y - z * w), coefficient * (x * z + y * w)],
    [coefficient * (x * y + z * w), 1 - coefficient * (x * x + z * z), coefficient * (y * z - x * w)],
    [coefficient * (x * z - y * w), coefficient * (y * z + x * w), 1 - coefficient * (x * x + y * y)],
  ];
}
function compose(a: Quaternion, b: Quaternion): Quaternion {
  // Composition is left-to-right as matrices: R(a*b) = R(a) * R(b).
  const an = Math.hypot(a.x, a.y, a.z, a.w), bn = Math.hypot(b.x, b.y, b.z, b.w);
  const x = a.x / an, y = a.y / an, z = a.z / an, w = a.w / an;
  const u = b.x / bn, v = b.y / bn, t = b.z / bn, s = b.w / bn;
  const output = { x: w * u + x * s + y * t - z * v,
    y: w * v - x * t + y * s + z * u,
    z: w * t + x * v - y * u + z * s,
    w: w * s - x * u - y * v - z * t };
  const length = Math.hypot(output.x, output.y, output.z, output.w);
  const component = (value: number) => cleanZero(Math.max(-1, Math.min(1, value / length)));
  return { x: component(output.x), y: component(output.y), z: component(output.z), w: component(output.w) };
}
function frameEqual(a: SpatialFrame, b: SpatialFrame): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function cleanZero(value: number): number { return value === 0 ? 0 : value; }

/** Converts a validated pose explicitly; no route or sensor calibration is inferred. */
export function createSpatialPoseConverter(sourceInput: ValueSchema, targetInput: ValueSchema,
  inputOptions: SpatialPoseConverterOptions): SpatialPoseConverter {
  const source = parseValueSchema(sourceInput), target = parseValueSchema(targetInput);
  if (source.type !== 'pose' || target.type !== 'pose') fail('spatial-shape', '$.target');
  const from = source as PoseSchema, to = target as PoseSchema;
  const options = snapshotJson(inputOptions);
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['decimalPlaces', 'maxAbsoluteError', 'transform'].includes(key)) ||
      !Object.hasOwn(options, 'decimalPlaces') || !Object.hasOwn(options, 'maxAbsoluteError')) fail('spatial-options', '$.options');
  const places = options.decimalPlaces, budget = options.maxAbsoluteError;
  if (typeof places !== 'number' || !Number.isInteger(places) || places < 0 || places > 12) fail('spatial-precision', '$.options.decimalPlaces');
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) fail('spatial-budget', '$.options.maxAbsoluteError');
  const factor = 10 ** places;
  let transform: Transform | undefined;
  if (from.frame.origin === to.frame.origin) {
    if (Object.hasOwn(options, 'transform')) fail('ambiguous-spatial-transform', '$.options.transform');
  } else {
    if (!Object.hasOwn(options, 'transform')) fail('spatial-transform-required', '$.options.transform');
    const declaration = options.transform;
    if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration) ||
        Object.keys(declaration).length !== 2 || !Object.hasOwn(declaration, 'schema') || !Object.hasOwn(declaration, 'value'))
      fail('spatial-transform', '$.options.transform');
    const schema = parseValueSchema(declaration.schema);
    if (schema.type !== 'transform' || !frameEqual(schema.from, from.frame) || !frameEqual(schema.to, to.frame))
      fail('spatial-transform-frame', '$.options.transform.schema');
    transform = parseSignalValue(declaration.value, schema) as unknown as Transform;
  }
  const unitScale = UNIT_SCALE[from.frame.unit] / UNIT_SCALE[to.frame.unit];
  const axisMap = axesMap(from.frame, to.frame);
  const mirrored = from.frame.handedness !== to.frame.handedness;
  const rotation = transform ? rotationMatrix(transform.rotation) : undefined;
  const map = rotation ? multiply(rotation, axisMap) : axisMap;
  const translation: Vector = transform ? [transform.translation.x, transform.translation.y, transform.translation.z] : [0, 0, 0];
  const projection = (row: Vector, offset: number): number =>
    Math.abs(offset) + from.extent * unitScale * row.reduce((sum, value) => sum + Math.abs(value), 0);
  const projected: Vector = [projection(map[0], translation[0]), projection(map[1], translation[1]),
    projection(map[2], translation[2])];
  const largest = Math.max(...projected, to.extent);
  const margin = Number.EPSILON * (from.extent * unitScale * 3 + largest + 1) * 64;
  const positionErrorBound = 0.5 / factor + margin;
  if (!Number.isFinite(unitScale) || projected.some((value) => !Number.isFinite(value) || Math.abs(value * factor) > Number.MAX_SAFE_INTEGER))
    fail('spatial-overflow', '$.target');
  if (positionErrorBound > budget) fail('spatial-budget', '$.options.maxAbsoluteError');
  if (projected.some((value) => Math.round((value + margin) * factor) / factor > to.extent)) fail('spatial-extent', '$.target.extent');
  const metadata: SpatialConversionMetadata = Object.freeze({ sourceFrame: from.frame, targetFrame: to.frame,
    unitScale, axisMap: Object.freeze(axisMap.map((row) => Object.freeze([...row])) as unknown as Matrix), mirrored,
    decimalPlaces: places, maxAbsoluteError: budget, positionErrorBound, transformed: Boolean(transform) });
  function coordinate(value: number): number {
    if (!Number.isFinite(value) || Math.abs(value * factor) > Number.MAX_SAFE_INTEGER) fail('spatial-overflow', '$');
    return cleanZero(Math.round(value * factor) / factor);
  }
  return Object.freeze({ metadata, convert(input: unknown): SignalValue {
    const value = parseSignalValue(input, from) as unknown as Pose;
    const position = product(map, [value.position.x, value.position.y, value.position.z]);
    const mapped: Vector = [coordinate(position[0] * unitScale + translation[0]),
      coordinate(position[1] * unitScale + translation[1]), coordinate(position[2] * unitScale + translation[2])];
    const sourceVector: Vector = [value.orientation.x, value.orientation.y, value.orientation.z];
    const axial = product(axisMap, sourceVector).map((member) => cleanZero((mirrored ? -1 : 1) * member)) as unknown as Vector;
    const orientation: Quaternion = { x: axial[0], y: axial[1], z: axial[2], w: value.orientation.w };
    const transformedOrientation = transform ? compose(transform.rotation, orientation) : orientation;
    const result = { position: { x: mapped[0], y: mapped[1], z: mapped[2] }, orientation: transformedOrientation };
    return parseSignalValue(result, to);
  } });
}
