// Legacy records deliberately retain their package-wide scope. A record with
// explicit identifiers covers only those advisories, including future reports.
export function reviewCoversAdvisories(record, entry) {
  if (record.advisoryIds === undefined) return true;
  const identifiers = new Set(record.advisoryIds);
  return entry.via.filter(via => typeof via === 'object').every(via => {
    const match = typeof via?.url === 'string' && /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/.exec(via.url);
    return Boolean(match && identifiers.has(match[1]));
  });
}
