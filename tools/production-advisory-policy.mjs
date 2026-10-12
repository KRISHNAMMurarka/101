// A review covers only its named advisories. A package name alone is insufficient.
export function reviewCoversAdvisories(record, entry) {
  if (!Array.isArray(record.advisoryIds) || !record.advisoryIds.length) return false;
  const identifiers = new Set(record.advisoryIds);
  return entry.via.filter(via => typeof via === 'object').every(via => {
    const match = typeof via?.url === 'string' && /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/.exec(via.url);
    return Boolean(match && identifiers.has(match[1]));
  });
}
