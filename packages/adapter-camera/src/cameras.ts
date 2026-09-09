/** Labels may be empty before permission; enumerating never requests camera access. */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return [];
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
  } catch {
    return [];
  }
}

export function describeCamera(device: Pick<MediaDeviceInfo, "label">): string {
  const label = device.label.trim();
  if (!label) return "Camera";
  if (/built[ -]?in|integrated|facetime|front camera/i.test(label)) return "Built-in camera";
  if (/external|\busb\b|logitech|brio|c920|c922/i.test(label)) return "External camera";
  return label;
}

export function cameraConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }),
    width: { ideal: 960 }, height: { ideal: 720 },
  };
}
