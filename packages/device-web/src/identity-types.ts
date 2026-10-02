/** Public-key possession is distinct from owner/account enrollment. */
export interface EndpointIdentity {
  readonly publicKey: Uint8Array;
  readonly keyId: string;
  readonly protection: 'webcrypto-nonextractable' | 'os-keystore' | 'secure-enclave';
  sign(message: Uint8Array): Promise<Uint8Array>;
  isCurrent(): Promise<boolean>;
  onInvalidated(listener: () => void): () => void;
}

/** Inject established cryptography; never implement a signature primitive here. */
export interface EndpointCrypto {
  randomBytes(length: number): Uint8Array;
  sha256(message: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
}
