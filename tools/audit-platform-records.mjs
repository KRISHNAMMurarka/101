import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const levels = ['implementation', 'contract', 'runtime', 'physical'];

/** Validate evidence relationships without promoting one evidence level into another. */
export function auditPlatformRecords({ checklist, catalog, evidence, exists }) {
  const errors = [];
  const tasks = [...checklist.matchAll(/^- \[([ x])\] \*\*([A-Z]\d{2}) —/gm)]
    .map(match => ({ id: match[2], complete: match[1] === 'x' }));
  const canonical = new Map();
  for (const task of tasks) {
    if (canonical.has(task.id)) errors.push(`duplicate checklist task ${task.id}`);
    canonical.set(task.id, task.complete);
  }
  const tally = checklist.match(/Snapshot tally:\*\* (\d+) tasks — (\d+) completed with recorded evidence; (\d+) open/);
  const completed = tasks.filter(task => task.complete).length;
  if (!tally || Number(tally[1]) !== tasks.length || Number(tally[2]) !== completed || Number(tally[3]) !== tasks.length - completed)
    errors.push('checklist snapshot tally does not match checkboxes');
  for (const [name, document] of [['catalog', catalog], ['evidence', evidence]]) {
    if (document.schemaVersion !== 1 || !Number.isSafeInteger(document.revision) || document.revision < 1)
      errors.push(`${name}: unsupported schema/revision`);
  }
  const records = new Map();
  for (const record of evidence.records) {
    if (records.has(record.id)) errors.push(`duplicate evidence record ${record.id}`);
    records.set(record.id, record);
    if (!['pass', 'fail', 'pending', 'unavailable'].includes(record.result)) errors.push(`${record.id}: invalid result`);
    if (!record.revision || !record.environment || !record.reproduction || !record.scope || !Array.isArray(record.equipment))
      errors.push(`${record.id}: incomplete evidence envelope`);
    if (record.result === 'fail' && !record.failure) errors.push(`${record.id}: failed receipt has no preserved failure`);
    if (!Array.isArray(record.levels) || record.levels.some(level => !levels.includes(level))) errors.push(`${record.id}: invalid evidence levels`);
    if (record.result === 'pass') {
      if (!record.paths?.length) errors.push(`${record.id}: passing evidence requires receipt paths`);
      if (!record.levels?.length) errors.push(`${record.id}: passing evidence requires evidence levels`);
    }
    for (const task of record.tasks) if (!canonical.has(task)) errors.push(`${record.id}: unknown task ${task}`);
    for (const path of record.paths) {
      if (path.startsWith('/') || path.split('/').includes('..') || !exists(path)) errors.push(`${record.id}: missing file ${path}`);
    }
  }
  const taskRecords = new Map();
  for (const task of evidence.tasks) {
    if (taskRecords.has(task.id)) errors.push(`duplicate task evidence ${task.id}`);
    taskRecords.set(task.id, task);
    if (!canonical.has(task.id)) errors.push(`unknown task evidence ${task.id}`);
    for (const dependency of task.dependencies) if (!canonical.has(dependency)) errors.push(`${task.id}: unknown dependency ${dependency}`);
    for (const ref of task.records) {
      const record = records.get(ref);
      if (!record || !record.tasks.includes(task.id)) errors.push(`${task.id}: absent or unscoped evidence ${ref}`);
    }
    if (canonical.get(task.id) && !task.records.some(ref => records.get(ref)?.result === 'pass' && records.get(ref)?.tasks.includes(task.id)))
      errors.push(`${task.id}: checked task needs passing evidence`);
  }
  for (const task of tasks) if (!taskRecords.has(task.id)) errors.push(`${task.id}: missing task evidence record`);
  const supportIds = new Set();
  for (const row of catalog.rows) {
    if (supportIds.has(row.id)) errors.push(`duplicate support row ${row.id}`);
    supportIds.add(row.id);
    if (!['embedded', 'historical', 'candidate', 'unsupported', 'unknown', 'qualified'].includes(row.status)) errors.push(`${row.id}: invalid support status`);
    if (!row.target.runtime || !row.target.runtimeVersion) errors.push(`${row.id}: runtime/version missing`);
    if (!Array.isArray(row.requiredLevels) || !row.requiredLevels.length || row.requiredLevels.some(level => !levels.includes(level)))
      errors.push(`${row.id}: required evidence levels missing/invalid`);
    for (const task of row.qualificationTasks) {
      if (!canonical.has(task)) errors.push(`${row.id}: unknown qualification ${task}`);
      else if (row.accepted && !canonical.get(task)) errors.push(`${row.id}: open qualification ${task}`);
    }
    for (const level of levels) {
      if (!Array.isArray(row.evidence[level])) { errors.push(`${row.id}: missing ${level} level`); continue; }
      if (row.accepted && row.requiredLevels?.includes(level) && !row.evidence[level].some(ref => records.get(ref)?.result === 'pass' && !records.get(ref)?.historical))
        errors.push(`${row.id}: acceptance requires current ${level} evidence`);
      for (const ref of row.evidence[level]) {
        const record = records.get(ref);
        if (!record) errors.push(`${row.id}: absent evidence ${ref}`);
        else {
          if (!record.levels.includes(level)) errors.push(`${row.id}: ${ref} does not prove ${level}`);
          if (row.accepted && record.historical) errors.push(`${row.id}: historical receipt cannot prove current acceptance`);
          if (row.accepted && !record.supportRows?.includes(row.id)) errors.push(`${row.id}: ${ref} is not bound to support row`);
          if (row.accepted && !isDeepStrictEqual(record.supportTargets?.[row.id], row.target)) errors.push(`${row.id}: ${ref} target identity changed or absent`);
        }
      }
    }
    if (row.accepted && (row.status !== 'qualified' || row.qualificationTasks.length === 0)) errors.push(`${row.id}: acceptance needs qualified scope`);
    if (row.status === 'unknown' && (row.accepted || levels.some(level => row.evidence[level]?.length))) errors.push(`${row.id}: unknown target cannot inherit evidence`);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..');
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const errors = auditPlatformRecords({
    checklist: read('docs/platform/MASTER-CHECKLIST.md'),
    catalog: JSON.parse(read('docs/platform/support-catalog.json')),
    evidence: JSON.parse(read('docs/platform/task-evidence.json')),
    exists: path => existsSync(resolve(root, path)),
  });
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Platform checklist, support levels, task evidence, IDs, links and tally agree.');
}
