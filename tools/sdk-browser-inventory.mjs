/** Public file shapes used by the immutable installed-browser SDK checks. */
export function isSdkBrowserPublicFile(packageName, value) {
  return typeof value === 'string' && (['LICENSE', 'README.md', 'package.json'].includes(value) ||
    /^(?:dist\/[^/]+\.(?:js|d\.ts)|schema\/device-descriptor\.json|examples\/[^/]+\.(?:js|ts|d\.ts))$/.test(value) ||
    packageName === '@101/connect' && ['examples/telemetry-owner.mjs',
      'examples/onboarding/onboarding.mjs', 'examples/onboarding/consumer.mjs'].includes(value));
}
