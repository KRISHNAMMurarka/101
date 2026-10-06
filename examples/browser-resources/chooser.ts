import { createBrowserChooserController } from '@101/connect';
import type { BrowserChooserDeclaration, BrowserChooserScope } from '@101/connect';

/** Diagnostic public caller for an unactivated browser execution. The descriptor
 * is an inert caller policy, not observed device identity or compatibility.
 * Human-initiated chooser selection and existing adapter capture remain separate. */
export async function checkBrowserChooserWithoutActivation() {
  if (navigator.userActivation?.isActive) throw new Error('Run this diagnostic without a user gesture');
  const device = { schemaVersion: 1, id: 'example:declared-input', label: 'Declared input policy', revision: 1,
    adapter: { id: 'example:explicit-chooser-policy', version: '1.0.0' }, runtime: { platform: 'declared-only' },
    capabilities: [{ id: 'reading', semantic: 'example:reading', schemaVersion: 1, kind: 'sample',
      value: { type: 'scalar', unit: '1', min: 0, max: 100 },
      delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 1000 }, permissions: ['subscribe'] }] };
  const declarations: BrowserChooserDeclaration[] = [
    { id: 'hid', kind: 'hid', device, capabilities: ['reading'], selection: { filters: [{ vendorId: 0x1234, productId: 1 }] } },
    { id: 'bluetooth', kind: 'bluetooth', device, capabilities: ['reading'], selection: { filters: [{ services: [0x180d] }], optionalServices: [0x180d] } },
    { id: 'serial', kind: 'serial', device, capabilities: ['reading'], selection: { filters: [{ usbVendorId: 0x1234, usbProductId: 1 }] } },
    { id: 'camera', kind: 'camera', device, capabilities: ['reading'], selection: {} },
    { id: 'audio', kind: 'audio', device, capabilities: ['reading'], selection: {} },
  ];
  const scope: BrowserChooserScope = { principalId: 'example:local-owner', applicationId: 'example:chooser', sessionId: 'example:local-visit' };
  let captureApprovalCalls = 0;
  const controller = createBrowserChooserController({ declarations, scope, now: () => performance.now(),
    authorizeCapture() { captureApprovalCalls++; return undefined; } });
  const initial = controller.snapshot();
  try {
    const outcomes = [];
    for (const declaration of declarations) outcomes.push({ id: declaration.id, ...(await controller.choose(declaration.id)) });
    controller.cancel(); controller.stop(); const stopped = controller.snapshot();
    const retry = await controller.choose('hid'); controller.close();
    return { kind: 'actual-browser-unactivated-chooser' as const,
      observed: { secureContext: isSecureContext, transientActivation: navigator.userActivation?.isActive === true,
        nativeApis: { hid: 'hid' in navigator, bluetooth: 'bluetooth' in navigator, serial: 'serial' in navigator } },
      initial, outcomes, stopped, retry, final: controller.snapshot(), captureApprovalCalls,
      limits: ['No chosen hardware, input capture, native permission dialog or resource operation grant.',
        'Camera/audio need a separately bound existing adapter lifecycle. Descriptor facts are declared, not observed.'] };
  } finally { controller.close(); }
}
