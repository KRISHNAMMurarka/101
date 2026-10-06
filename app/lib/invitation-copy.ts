export type InvitationCopyResult = 'copied' | 'manual' | 'stopped';

/** The caller owns one pending copy until the native write settles. */
export async function copyInvitationLink(options: {
  url: string;
  writeText: (text: string) => Promise<void> | undefined;
  isCurrent: () => boolean;
}): Promise<InvitationCopyResult> {
  const current = () => { try { return options.isCurrent(); } catch { return false; } };
  if (!options.url || !current()) return 'stopped';
  try {
    const nativeWrite = options.writeText(options.url);
    if (nativeWrite === undefined) return current() ? 'manual' : 'stopped';
    await nativeWrite;
    return current() ? 'copied' : 'stopped';
  } catch {
    return current() ? 'manual' : 'stopped';
  }
}
