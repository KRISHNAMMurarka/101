export { DeviceValidationError, parseDeviceDescriptor, parseValueSchema, snapshotJson } from './descriptor.ts';
export type {
  DeviceCapability, DeviceDescriptor, DeliveryPolicy, JsonObject, JsonValue,
  OwnershipPolicy, PermissionOperation, SignalValue, ValueSchema,
  SpatialAxis, SpatialFrame, SpatialJoint,
} from './descriptor.ts';
export { parseSignalValue, schemasCompatible } from './sample.ts';
export { DEVICE_DESCRIPTOR_SCHEMA } from './descriptor-schema.ts';
export { RemoteClockMap } from './remote-clock.ts';
export type { RemoteClockObservation, RemoteClockOptions, RemoteClockTranslation } from './remote-clock.ts';
export { createUnitConverter, parseUnitToken } from './units.ts';
export type { UnitConverter, UnitConverterOptions, UnitConversionMetadata } from './units.ts';
export { createSpatialPoseConverter } from './spatial.ts';
export type { SpatialPoseConverter, SpatialPoseConverterOptions, SpatialConversionMetadata } from './spatial.ts';
export { createAssetReference, parseAssetReference, verifyAssetContent, snapshotResourceBytes, MAX_RESOURCE_BYTES, MAX_RESOURCE_CHUNK_BYTES } from './resource.ts';
export type { AssetKind, AssetReference } from './resource.ts';
export { parseMediaManifest, planMediaBinding } from './media.ts';
export type { MediaRange, AudioProperties, VideoProperties, VideoGeometry, MediaTrackDescription,
  RenderTargetDescription, MediaManifest, MediaEndpointProbe, MediaHostProbe, MediaBindingResult } from './media.ts';
export { parseMeasurementReport } from './quality.ts';
export type { MeasurementFault, MeasurementReport } from './quality.ts';
export { createScalarCalibrationProcessor, createScalarConversionProcessor, createMovingAverageProcessor } from './measurement-processors.ts';
export type { MeasurementFrame, ProcessorIdentity, CalibrationOptions, ConversionOptions, MovingAverageOptions, ScalarMeasurementProcessor } from './measurement-processors.ts';
export { quaternionFromDeviceOrientation, quaternionToAngles, relativeQuaternion, multiplyQuaternions, conjugateQuaternion, normalizeQuaternion } from './motion-math.ts';
export type { Quaternion, Vector3, MotionAngles } from './motion-math.ts';
export { parseMotionMeasurement, createMotionUnitProcessor, createMotionCalibrationProcessor, createMotionSmoothingProcessor } from './motion-processors.ts';
export type { MotionMeasurement, MotionMeasurementProcessor, MotionCalibrationOptions, MotionSmoothingOptions } from './motion-processors.ts';
export { createDeadzoneMapper, createHysteresisEdgeProcessor, createLatestResampler } from './generic-processors.ts';
export type { DeadzoneOptions, HysteresisOptions, ResamplerOptions, HysteresisEdge, HysteresisEdgeProcessor, LatestResampler } from './generic-processors.ts';
export { parseObservationTiming, observationAgeBounds, compareClockStamps } from './observation-timing.ts';
export type { ClockStamp, CaptureMapping, ProcessorTimingStep, ObservationTiming } from './observation-timing.ts';
export { parseDeviceHealthReport, assessDeviceHealth } from './health.ts';
export type { DeviceHealthFault, DeviceHealthResource, DeviceHealthReport, DeviceHealthAssessment } from './health.ts';
export { planDescriptorEvolution } from './evolution.ts';
export type { DescriptorEvolution } from './evolution.ts';
export { exportWoTThingDescription, importWoTThingDescription } from './wot.ts';
export type { WoTBindings, WoTForm, WoTAffordance, WoTThingDescription } from './wot.ts';
export { parseDiscoveryCandidate, assessDiscoveryCandidate } from './discovery.ts';
export type { DiscoveryStage, DiscoveryScope, DiscoveryEvidence, DiscoveryRecovery,
  DiscoveryCandidate, DiscoveryAssessment, DiscoveryReceiptVerifier } from './discovery.ts';
export { INPUT_PROFILE_IDS, getInputProfile } from './input-profile.ts';
export type { InputProfile, InputProfileId } from './input-profile.ts';
export { createPenDetailProcessor, createRotaryDeltaProcessor, createGamepadDetailProcessor } from './input-details.ts';
export type { PenCalibration, RawPenDetail, GamepadAxisCalibration, GamepadTriggerCalibration, GamepadDetailConfig, RawGamepadDetail } from './input-details.ts';
export { parseProcessorManifest } from './processor-manifest.ts';
export type { ProcessorAsset, ProcessorManifest, ProcessorPort } from './processor-manifest.ts';
export { validateProcessorGraph } from './processor-graph.ts';
export type { ProcessorGraphNode, ProcessorGraphEndpoint, ProcessorGraphEdge, ProcessorGraphPlan, ProcessorFeedbackBound } from './processor-graph.ts';
export { planRouteGroup } from './route-group.ts';
export type { RouteGroupEndpoint, RouteGroupMember, RouteGroupPlan } from './route-group.ts';
export { parseWorkloadRequirements } from './workload.ts';
export type { WorkloadRuntime, WorkloadBudget, WorkloadResource, WorkloadRequirements } from './workload.ts';
export { parseRecipe } from './recipe.ts';
export type { Recipe, RecipeResource, RecipeProcessor, RecipeRoute, RecipeEndpoint,
  RecipePermission, RecipeStyle, RecipeComponent, RecipeSurface } from './recipe.ts';
export { resolveRecipe } from './recipe-resolver.ts';
export type { RecipeSelection, RecipeAlternative, RecipeResolutionIssue, ResolvedRecipe,
  RecipeResolution } from './recipe-resolver.ts';
