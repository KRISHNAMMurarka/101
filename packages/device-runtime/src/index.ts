export { EmbeddedRuntime } from "./runtime.ts";
import { EmbeddedRuntime } from "./runtime.ts";
import type { DeviceRuntime, RuntimeOptions } from "./types.ts";
export const createDeviceRuntime = (options: RuntimeOptions): DeviceRuntime => new EmbeddedRuntime(options);
export type * from "./types.ts";
export type { Evidence, EffectEvidence, HandlerResult, OperationRecord, OperationState, Result } from "./scheduler.ts";
export { chunkResource, readVerifiedResource, ResourceTransferError } from './resource.ts';
export type { ResourceChunk, ResourceReadScope, ResourceReadRequest, ResourceReadGrant, ReadVerifiedResourceOptions } from './resource.ts';
export { createProcessorRegistry } from './processor-registry.ts';
export type { ProcessorFrame, ProcessorImplementation, ProcessorRequest, ResolvedProcessor, TrustedProcessorRegistration } from './processor-registry.ts';
export { createPlacementScheduler } from './placement.ts';
export type { Placement, PlacementAuthorityRequest, PlacementPrincipal, PlacementResource, PlacementResult, PlacementScheduler, PlacementSchedulerOptions } from './placement.ts';
export { createApplicationSnapshot, restoreApplicationSnapshot } from './application-snapshot.ts';
export type { ApplicationSnapshot, SnapshotRestoreResult } from './application-snapshot.ts';
export { createDeviceSimulator } from './simulator.ts';
export type { DeviceSimulator, SimulatorEvent } from './simulator.ts';
export { createRouteGroupController } from './route-group-runtime.ts';
export type { RouteGroupController } from './route-group-runtime.ts';
export { createWorkloadHandoff } from './workload-handoff.ts';
export type { HandoffEpoch, HandoffHost, HandoffResult, WorkloadHandoff, WorkloadHandoffOptions } from './workload-handoff.ts';
export { createProcessorFailureController } from './processor-failure.ts';
export type { ProcessorFailureBinding, ProcessorFailureController, ProcessorFailureOptions, ProcessorRunResult } from './processor-failure.ts';
export { createRecipeSession } from './recipe-session.ts';
export type { RecipeEndpointBinding, RecipeConsentPreview, RecipeSessionOptions, RecipeSession } from './recipe-session.ts';
export { createSettingsStore, createIndexedDbSettingsStorage } from './settings-store.ts';
export type { SettingsStorage, SettingsPreferences, StoredProfileChoice, SettingsDocument, SettingsResult, SettingsStore, SettingsStoreOptions, IndexedDbSettingsStorage } from './settings-store.ts';
export { runConnectorConformance, runProcessorConformance } from './conformance.ts';
export type { ConformanceCheck, ConformanceReport, ConformanceEndpoint, ConnectorConformanceHost, ConnectorConformanceAdapter, TrustedConnectorCandidate, ConnectorConformanceFixture, ProcessorConformanceFixture } from './conformance.ts';
export { createRuntimeInspector, InspectorDiagnosticError } from './inspector.ts';
export type { RuntimeInspector, RuntimeInspectorOptions, InspectorAction, InspectorGrant, InspectorTrace, InspectorResource, InspectorRoute, InspectorSnapshot } from './inspector.ts';
export * from './telemetry-history.ts';
export * from './telemetry-storage.ts';
export * from './durable-artifact-jobs.ts';
export { createApplicationViews } from './application-views.ts';
export type { ApplicationViewRequest, ApplicationViewDefinition, ApplicationViewOutput, ApplicationViewHandle, AttachApplicationViewResult, ApplicationViewsOptions, ApplicationViews } from './application-views.ts';

export { createProcessorInstallation } from './processor-installation.ts';
export { createOwnerDataController, OWNER_DATA_PROFILE, OWNER_DATA_LIMITS } from './owner-data.ts';
export type { OwnerDataStorage, OwnerDataController, OwnerDataOptions, OwnerDataScope, OwnerDataGrant, OwnerDataSelection, OwnerDataPorts, OwnerDataResult, OwnerDataExportPage, OwnerDataDeletion, OwnerDataAudit, OwnerDataFailure } from './owner-data.ts';
export { createIndexedDbOwnerDataStorage } from './owner-data-storage.ts';
export type { IndexedDbOwnerDataStorage } from './owner-data-storage.ts';

export { createTrustedConnectorProfileRegistry, createProfileConnector } from './profile-connector.ts';
export type { TrustedConnectorProfileRegistration, ConnectorProfileRequest, ReviewedConnectorProfileBinding, TrustedConnectorProfileRegistry, ConnectorDecoder, ConnectorDecodeContext, ConnectorDecodedOutput, ConnectorProfileSample, ConnectorCaptureHandle, ConnectorWriteContext, ProfileConnectorOptions, ProfileConnector } from './profile-connector.ts';

export { INPUT_OWNERSHIP_PROFILE, INPUT_OWNERSHIP_LIMITS, createInputOwnershipController } from './input-ownership.ts';
export type { InputOwnershipController, InputOwnershipOptions, InputOwnershipSource, InputOwnershipDestination, InputOwnershipResource, InputOwnershipSnapshot, InputOwnershipRequest, InputOwnershipOwner, InputOwnershipResult, InputOwnershipFailure } from './input-ownership.ts';

export { createLocalPackageCatalog } from './package-catalog.ts';
export type { LocalPackageCatalog, LocalPackageCatalogOptions, LocalPackageCatalogRole, LocalPackageCatalogAction, LocalPackageCatalogStatus, LocalPackageCatalogFailure, LocalPackageCatalogResult, LocalPackageCatalogWriteGuard, LocalPackageCatalogStorage, LocalPackageCatalogTrust, LocalPackageCatalogOwnerTrust, LocalPackageCatalogScope, LocalPackageCatalogApproval, LocalPackageCatalogReleaseSummary, LocalPackageCatalogSnapshot } from './package-catalog.ts';
export type { ProcessorInstallationWriteGuard, ProcessorInstallationStorage, ProcessorPublisherTrust, ProcessorInstallationAction, ProcessorInstallationScope, ProcessorInstallationApproval, ProcessorInstallationFailure, ProcessorInstallationResult, ProcessorInstallationPackage, ProcessorInstallationSnapshot, ReviewedProcessorActivationRequest, ProcessorExtensionActivation, ProcessorInstallation, ProcessorInstallationOptions } from './processor-installation.ts';

export { intersectMediaRouteGrants } from './media-grants.ts';

export { createHapticOutputController, createBrowserHapticBackend } from './haptic-output.ts';
export type { HapticBackendOutcome, HapticOutcome, HapticBackend, HapticOutputEvidence, HapticOutputOptions, HapticOutputController } from './haptic-output.ts';

export { OWNER_BACKUP_PROFILE, OWNER_BACKUP_LIMITS, createOwnerBackupController } from './owner-backup.ts';
export type { OwnerBackupFailure, OwnerBackupResult, OwnerBackupScope, OwnerBackupGrant, OwnerBackupReceipt, OwnerBackupRequest, OwnerBackupOptions, OwnerBackupController } from './owner-backup.ts';

export { PROFILE_RESOLUTION_LIMITS, createProfileResolutionController } from './profile-resolution.ts';
export type { ProfileObservationHandle, ProfileReviewHandle, ProfileChoiceHandle, ProfileResolutionOptions, ProfileResolutionFailure, ProfileResolutionResult, ProfileResolutionSelection, ProfileResolutionSnapshot, ProfileResolutionController } from './profile-resolution.ts';

export { CAPABILITY_INVENTORY_LIMITS, createCapabilityInventory } from "./capability-inventory.ts";
export type { CapabilityInventoryResource, CapabilityInventorySelection, CapabilityInventoryScope, CapabilityInventoryOptions, CapabilityInventoryProof, CapabilityInventoryReason, CapabilityInventoryRow, CapabilityInventorySnapshot, CapabilityInventoryResult, CapabilityInventoryController } from "./capability-inventory.ts";

export { OPERATOR_HEALTH_PROFILE, OPERATOR_HEALTH_LIMITS, createOperatorHealthMonitor } from './operator-health.ts';
export type { OperatorHealthKind, OperatorHealthSource, OperatorHealthScope, OperatorHealthGrant, OperatorHealthOptions, OperatorHealthReason, OperatorHealthResult, OperatorRuntimeMetrics, OperatorWssMetrics, OperatorSourceHealth, OperatorHealthSample, OperatorHealthSnapshot, OperatorHealthMonitor } from './operator-health.ts';

export { NATIVE_DISCOVERY_PROFILE, NATIVE_DISCOVERY_LIMITS, createNativeDiscoveryController } from './native-discovery.ts';
export type { NativeDiscoveryScope, NativeDiscoveryGrant, NativeDiscoveryService, NativeDiscoveryEvent, NativeDiscoveryOperation, NativeDiscoveryProvider, NativeDiscoveryOptions, NativeDiscoveryHandle, NativeDiscoveryRow, NativeDiscoverySnapshot, NativeDiscoveryResult, NativeDiscoveryController } from './native-discovery.ts';

export { createWorkspaceAdministration, WORKSPACE_ADMINISTRATION_PROFILE, WORKSPACE_ADMINISTRATION_LIMITS } from './workspace-administration.ts';
export type * from './workspace-administration.ts';

export { createWatchCompanionResources } from './watch-companion.ts';
export type { WatchCompanionEnrollment, WatchCompanionRelaySnapshot, WatchCompanionBridge, WatchCompanionReportEvent,
  WatchCompanionResourceRequest, WatchCompanionResourceOwnerGrant, WatchCompanionResourcesOptions, WatchCompanionResources,
  WatchCompanionResult } from './watch-companion.ts';
export { RECORDING_OWNER_DATA_PROFILE, RECORDING_OWNER_DATA_LIMITS, createRecordingOwnerData } from './recording-owner-data.ts';
export type { RecordingOwnerDataFailure, RecordingOwnerDataResult, RecordingOwnerDataScope, RecordingOwnerDataGrant, RecordingOwnerDataOptions, RecordingOwnerDataPort, RecordingOwnerDataFrame, RecordingOwnerDataExportPage, RecordingOwnerDataDeletion, RecordingOwnerDataAudit, RecordingOwnerDataController } from './recording-owner-data.ts';

export { MEDIA_RECORDING_LIMITS, createMediaRecording } from './media-recording.ts';
export type { MediaRecordingSource, MediaRecordingFrame, MediaRecordingSourceContext, MediaRecordingRequest, MediaRecordingGrant, MediaRecordingCaptureRequest, MediaRecordingPlaybackRequest, MediaRecordingReviewRequest, MediaRecordingExportRequest, MediaRecordingDeleteRequest, MediaRecordingOptions, MediaRecordingCaptureHandle, MediaRecordingPlaybackHandle, MediaRecordingFailure, MediaRecordingResult, MediaRecordingStoredFrame, MediaRecordingClip, MediaRecordingPlaybackFrame, MediaRecordingExportPage, MediaRecording } from './media-recording.ts';

export { MEDIA_SYNCHRONIZATION_PROFILE, MEDIA_SYNCHRONIZATION_LIMITS, createMediaSynchronizationController } from './media-synchronization.ts';
export type { MediaSynchronizationRole, MediaSynchronizationState, MediaSynchronizationReason, MediaSynchronizationSource, MediaSynchronizationPair, MediaSynchronizationEffectContext, MediaSynchronizationOptions, MediaSynchronizationSnapshot, MediaSynchronizationController } from './media-synchronization.ts';

export { OUTPUT_SHARING_PROFILE, OUTPUT_SHARING_LIMITS, createOutputSharingController } from './output-sharing.ts';
export type { OutputSharingKind, OutputSharingInput, OutputSharingPolicy, OutputSharingSource, OutputSharingSlot, OutputSharingDestination, OutputSharingPolicyRequest, OutputSharingPolicyGrant, OutputSharingResourceRequest, OutputSharingResourceGrant, OutputSharingFailure, OutputSharingResult, OutputSharingPlan, OutputSharingRoute, OutputSharingEffectContext, OutputSharingOptions, OutputSharingController } from './output-sharing.ts';
