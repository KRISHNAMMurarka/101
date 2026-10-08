import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPlatformRecords } from '../tools/audit-platform-records.mjs';

function fixture() {
  return {
    checklist: '**Snapshot tally:** 2 tasks — 1 completed with recorded evidence; 1 open.\n- [x] **H01 — Foundation.**\n- [ ] **T01 — Transport.**',
    catalog: { schemaVersion: 1, revision: 1, rows: [{
      id: 'embedded', status: 'embedded', accepted: false,
      requiredLevels: ['implementation', 'contract', 'runtime', 'physical'],
      qualificationTasks: ['H01'], target: { runtime: 'Node', runtimeVersion: '24.14.0' },
      evidence: { implementation: ['foundation'], contract: ['foundation'], runtime: ['foundation'], physical: [] as string[] },
    }] },
    evidence: { schemaVersion: 1, revision: 1, records: [{
      id: 'foundation', revision: '32e0e37', result: 'pass', historical: true, supportRows: ['embedded'],
      supportTargets: { embedded: { runtime: 'Node', runtimeVersion: '24.14.0' } },
      levels: ['implementation', 'contract', 'runtime'], tasks: ['H01'],
      paths: ['docs/platform/FOUNDATION-QA-2026-10-01.md'],
      environment: 'Node embedded', reproduction: 'npm run example:devices',
      scope: 'Embedded providers only', failure: null as string | null, equipment: [],
    }], tasks: [{ id: 'H01', records: ['foundation'], dependencies: [] as string[], equipment: [] },
      { id: 'T01', records: [], dependencies: ['H01'], equipment: [] }] },
    exists: () => true,
  };
}

test('an embedded receipt verifies its recorded levels without inventing physical support', () => {
  assert.deepEqual(auditPlatformRecords(fixture()), []);
  const input = fixture();
  input.catalog.rows[0].evidence.physical.push('foundation');
  assert.ok(auditPlatformRecords(input).some(error => error.includes('physical')));
});

test('checked tasks require scoped passing evidence, while failed receipts remain valid history', () => {
  const input = fixture();
  input.evidence.records[0].result = 'fail';
  input.evidence.records[0].failure = 'Recorded failed reproduction';
  assert.ok(auditPlatformRecords(input).some(error => error.includes('H01') && error.includes('passing evidence')));
  input.checklist = input.checklist.replace('1 completed with recorded evidence; 1 open', '0 completed with recorded evidence; 2 open').replace('[x]', '[ ]');
  assert.deepEqual(auditPlatformRecords(input), []);
});

test('open tasks cannot omit a record that declares evidence for them', () => {
  const input = fixture();
  input.evidence.records[0].tasks.push('T01');
  assert.ok(auditPlatformRecords(input).some(error =>
    error === 'foundation: task T01 omits evidence reference'));
});

test('catalog rows cannot advertise current acceptance using historical or incomplete qualification', () => {
  const input = fixture();
  input.catalog.rows[0].accepted = true;
  assert.ok(auditPlatformRecords(input).some(error => error.includes('historical')));
  assert.ok(auditPlatformRecords(input).some(error => error.includes('physical')));
  input.evidence.records[0].historical = false;
  input.catalog.rows[0].qualificationTasks.push('T01');
  assert.ok(auditPlatformRecords(input).some(error => error.includes('open qualification')));
});

test('audit rejects duplicate and unknown task IDs, dangling evidence, missing files and tally drift', () => {
  const input = fixture();
  input.evidence.tasks.push(input.evidence.tasks[0]);
  input.evidence.tasks[1].dependencies.push('X99');
  input.catalog.rows[0].evidence.runtime.push('absent');
  input.exists = () => false;
  input.checklist = input.checklist.replace('2 tasks', '3 tasks');
  const errors = auditPlatformRecords(input);
  for (const text of ['duplicate', 'X99', 'absent', 'missing file', 'tally'])
    assert.ok(errors.some(error => error.includes(text)), text);
});

test('unknown support combinations carry no inherited evidence or acceptance', () => {
  const input = fixture();
  input.catalog.rows[0].status = 'unknown';
  assert.ok(auditPlatformRecords(input).some(error => error.includes('unknown')));
});

test('current acceptance requires evidence bound to this exact support row and declared levels', () => {
  const input = fixture();
  input.catalog.rows[0].accepted = true;
  input.catalog.rows[0].status = 'qualified';
  input.catalog.rows[0].requiredLevels = ['implementation', 'contract', 'runtime'];
  input.evidence.records[0].historical = false;
  assert.deepEqual(auditPlatformRecords(input), []);
  input.evidence.records[0].supportRows = ['different-device'];
  assert.ok(auditPlatformRecords(input).some(error => error.includes('bound to support row')));
});

test('changing a qualified target version or profile invalidates its prior receipt', () => {
  const input = fixture();
  input.catalog.rows[0].accepted = true;
  input.catalog.rows[0].status = 'qualified';
  input.catalog.rows[0].requiredLevels = ['implementation', 'contract', 'runtime'];
  input.evidence.records[0].historical = false;
  assert.deepEqual(auditPlatformRecords(input), []);
  input.catalog.rows[0].target.runtimeVersion = '99.0.0';
  assert.ok(auditPlatformRecords(input).some(error => error.includes('target identity changed')));
});

test('passing evidence cannot close tasks after its receipt links or evidence levels disappear', () => {
  const input = fixture();
  input.evidence.records[0].paths = [];
  input.evidence.records[0].levels = [];
  input.catalog.rows[0].evidence = { implementation: [], contract: [], runtime: [], physical: [] };
  const errors = auditPlatformRecords(input);
  assert.ok(errors.some(error => error.includes('receipt paths')));
  assert.ok(errors.some(error => error.includes('evidence levels')));
});

test('a current failed receipt for the accepted target blocks support even when omitted from its evidence list', () => {
  const input = fixture();
  const row = input.catalog.rows[0];
  row.accepted = true;
  row.status = 'qualified';
  row.requiredLevels = ['implementation', 'contract', 'runtime'];
  input.evidence.records[0].historical = false;
  assert.deepEqual(auditPlatformRecords(input), []);
  const failure = { ...input.evidence.records[0], id: 'new-failure', result: 'fail',
    failure: 'Current runtime reproduction failed', levels: ['runtime'],
    supportTargets: { embedded: structuredClone(row.target) } };
  input.evidence.records.push(failure);
  input.evidence.tasks[0].records.push(failure.id);
  assert.ok(auditPlatformRecords(input).some(error => error.includes('embedded') && error.includes('current fail receipt')));
  failure.supportTargets.embedded.runtimeVersion = 'older-version';
  assert.deepEqual(auditPlatformRecords(input), [], 'a failure for a different target must not block this version');
});

test('an accepted row cannot cite failed or pending records as support evidence', () => {
  const input = fixture();
  const row = input.catalog.rows[0];
  row.accepted = true;
  row.status = 'qualified';
  row.requiredLevels = ['implementation', 'contract', 'runtime'];
  input.evidence.records[0].historical = false;
  const pending = { ...input.evidence.records[0], id: 'pending-probe', result: 'pending', levels: ['runtime'] };
  input.evidence.records.push(pending);
  input.evidence.tasks[0].records.push(pending.id);
  row.evidence.runtime.push(pending.id);
  assert.ok(auditPlatformRecords(input).some(error => error.includes('pending-probe') && error.includes('passing')));
});
