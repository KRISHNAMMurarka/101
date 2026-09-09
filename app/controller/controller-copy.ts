/**
 * Secondary labels describe a control only when they add information. Repeating the same word in a
 * small control makes the deck harder to scan without helping someone operate it.
 */
export function controllerHint(label: string, hint: string): string | undefined {
  const normalizedLabel = normalize(label);
  const normalizedHint = normalize(hint);
  if (!normalizedLabel || !normalizedHint || normalizedLabel.includes(normalizedHint)) return undefined;
  return hint;
}

function normalize(value: string) {
  return value.toLocaleLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, "");
}
