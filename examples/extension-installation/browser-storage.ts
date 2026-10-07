import { createBrowserProcessorInstallationStorage, createProcessorInstallation, verifyProcessorExtensionRelease } from '@101/connect';
import type { ProcessorInstallation, ProcessorInstallationApproval, ProcessorInstallationScope,
  ProcessorInstallationStorage, ProcessorConformanceFixture, ProcessorExtensionRelease, TrustedProcessorRegistration } from '@101/connect';

/** Supplied by a reviewed host from its fixed original source/signature provision.
 * Release fields never choose an import, key, factory, configuration or grant. */
export interface ReviewedBrowserProcessorVersion {
  readonly release: Readonly<ProcessorExtensionRelease>;
  readonly trusted: TrustedProcessorRegistration;
  readonly fixture: ProcessorConformanceFixture;
}
export interface ReviewedBrowserProcessorBundle {
  readonly key: CryptoKey;
  readonly publisherId: string;
  readonly minimumSequence: number;
  readonly versions: readonly ReviewedBrowserProcessorVersion[];
}
export interface BrowserProcessorStorageExampleOptions {
  readonly ownerId: string;
  readonly bundle: ReviewedBrowserProcessorBundle;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  readonly locks?: Pick<LockManager, 'request'>;
  readonly now: () => number;
  readonly authorize: (scope: ProcessorInstallationScope) => ProcessorInstallationApproval | undefined | Promise<ProcessorInstallationApproval | undefined>;
}
export interface BrowserProcessorStorageExample {
  readonly installation: ProcessorInstallation;
  readonly storage: ProcessorInstallationStorage;
  readonly reviewedVersions: readonly ReviewedBrowserProcessorVersion[];
  /** Retires installation authority immediately and awaits this storage's issued
   * requests. Public installer close does not expose native WebCrypto settlement. */
  close(): Promise<void>;
}

/** Explicit host action. Importing this module creates no storage, key or grant.
 * The caller owns all live routes and must retire them through retireOwned. */
export async function createBrowserProcessorStorageExample(options: BrowserProcessorStorageExampleOptions): Promise<BrowserProcessorStorageExample> {
  const bundle = options.bundle;
  if (!bundle || typeof options.authorize !== 'function' || typeof options.now !== 'function' ||
    !Array.isArray(bundle.versions) || bundle.versions.length < 1 || bundle.versions.length > 2 ||
    typeof bundle.publisherId !== 'string' || !Number.isSafeInteger(bundle.minimumSequence) || bundle.minimumSequence < 1)
    throw new TypeError('browser-processor-example-provision');
  const versions: ReviewedBrowserProcessorVersion[] = [];
  for (const value of bundle.versions) {
    if (value.release.publisherId !== bundle.publisherId || value.release.sequence < bundle.minimumSequence ||
      value.trusted.manifest !== value.release.manifest || typeof value.trusted.factory !== 'function' ||
      !await verifyProcessorExtensionRelease(value.release, value.trusted.source, bundle.key))
      throw new TypeError('browser-processor-example-integrity');
    versions.push(Object.freeze({ release: value.release, trusted: value.trusted, fixture: value.fixture }));
  }
  const session = createBrowserProcessorInstallationStorage({ ownerId: options.ownerId, storage: options.storage, locks: options.locks });
  let installation: ProcessorInstallation;
  try {
    installation = createProcessorInstallation({ ownerId: options.ownerId, storage: session.storage, now: options.now,
      authorize: options.authorize,
      publisherTrust: id => id === bundle.publisherId ? { key: bundle.key, minimumSequence: bundle.minimumSequence } : undefined });
  } catch {
    await session.close();
    throw new TypeError('browser-processor-example-unavailable');
  }
  let closing: Promise<void> | undefined;
  return Object.freeze({ installation, storage: session.storage, reviewedVersions: Object.freeze(versions), close() {
    if (closing) return closing;
    let resolve!: () => void, reject!: (cause: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    installation.close();
    void session.close().then(resolve, reject);
    return closing;
  } });
}
