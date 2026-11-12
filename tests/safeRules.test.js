'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSafeRulesServer } = require('../server');
const {
  evaluateStructuredRule,
  validateRuleStructure
} = require('../src/engine/ruleModel');
const {
  detectCycles,
  computeRecommendedOrder,
  validateExecutionOrder,
  analyzeDownstreamImpact
} = require('../src/engine/dependencyGraph');
const {
  synthesizeRuleFromNaturalLanguage
} = require('../src/engine/aiAssistant');
const {
  writeXlsxBuffer,
  parseXlsxBuffer,
  toCsv,
  parseCsv
} = require('../src/engine/xlsxCodec');

let serverInstance;
let baseUrl;
let dbInstance;

test.before(async () => {
  const { server, db } = createSafeRulesServer(':memory:');
  serverInstance = server;
  dbInstance = db;
  await new Promise((resolve) => {
    serverInstance.listen(0, '127.0.0.1', () => {
      const addr = serverInstance.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (serverInstance) {
    await new Promise(resolve => serverInstance.close(resolve));
  }
});

async function api(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await res.json();
    return { status: res.status, body, headers: res.headers };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buffer: buf, headers: res.headers };
}

test('Specification Section 5 & SC-08: Exact benchmark orders 1001, 1002, 1003 and all 5 record statuses', async () => {
  const { status, body } = await api('/api/results');
  assert.equal(status, 200);
  assert.ok(body.records.length >= 100, 'Should evaluate at least 100 main records');

  const r1001 = body.records.find(r => r.recordId === '1001');
  const r1002 = body.records.find(r => r.recordId === '1002');
  const r1003 = body.records.find(r => r.recordId === '1003');
  const r1099 = body.records.find(r => r.recordId === '1099');

  // 1001 | Window A | Igen | OK | Accepted
  assert.ok(r1001);
  assert.equal(r1001.sourceData.termek, 'Window A');
  assert.equal(r1001.enrichedData.gyarthato, 'Igen');
  assert.equal(r1001.enrichedData.cimellenorzes, 'OK');
  assert.equal(r1001.finalStatus, 'Accepted');

  // 1002 | Door B | Nem | OK | Error
  assert.ok(r1002);
  assert.equal(r1002.sourceData.termek, 'Door B');
  assert.equal(r1002.enrichedData.gyarthato, 'Nem');
  assert.equal(r1002.enrichedData.cimellenorzes, 'OK');
  assert.equal(r1002.finalStatus, 'Error');

  // 1003 | Window C | Igen | Review | Requires Review
  assert.ok(r1003);
  assert.equal(r1003.sourceData.termek, 'Window C');
  assert.equal(r1003.enrichedData.gyarthato, 'Igen');
  assert.equal(r1003.enrichedData.cimellenorzes, 'Review');
  assert.equal(r1003.finalStatus, 'Requires Review');

  // 1099 | Technical error isolation -> Execution Failed (Section 11 & 12)
  assert.ok(r1099);
  assert.equal(r1099.finalStatus, 'Execution Failed');
});

test('SC-02 & Section 9: At least 80 interdependent rules across all 4 lifecycle states (Draft, Test, Prod, Retired)', async () => {
  const { status, body } = await api('/api/rules');
  assert.equal(status, 200);
  assert.equal(body.rules.length, 85, 'Should have 85 total rules');

  const prodRules = body.rules.filter(r => r.lifecycleStatus === 'Prod');
  const testRules = body.rules.filter(r => r.lifecycleStatus === 'Test');
  const draftRules = body.rules.filter(r => r.lifecycleStatus === 'Draft');
  const retiredRules = body.rules.filter(r => r.lifecycleStatus === 'Retired');

  assert.equal(prodRules.length, 80, 'Should have 80 active Prod rules');
  assert.ok(testRules.length >= 1, 'Should include Test lifecycle rules');
  assert.ok(draftRules.length >= 1, 'Should include Draft lifecycle rules');
  assert.ok(retiredRules.length >= 1, 'Should include Retired lifecycle rules');

  assert.equal(body.dependencyGraph.valid, true);
  assert.equal(body.dependencyGraph.hasCycle, false);
  assert.ok(body.dependencyGraph.edges.length >= 60, 'Should have rich multi-layer dependency edges');
});

test('SC-04 & Section 9: Dependency cycle detection, invalid manual order rejection, and impact analysis', async () => {
  // 1. Cycle detection test
  const cyclicRules = [
    { id: 'C-1', name: 'Rule 1', output: { outputField: 'f1' }, inputFields: ['f2'], dependencies: ['C-2'] },
    { id: 'C-2', name: 'Rule 2', output: { outputField: 'f2' }, inputFields: ['f1'], dependencies: ['C-1'] }
  ];
  const cycleRes = detectCycles(cyclicRules);
  assert.equal(cycleRes.hasCycle, true);
  assert.ok(cycleRes.message.includes('Körkörös függőség'));

  // 2. Manual order violation rejection via API (R-048 depends on R-010, R-022, R-035, R-047)
  const rulesRes = await api('/api/rules');
  const activeIds = rulesRes.body.rules.filter(r => r.lifecycleStatus !== 'Retired').map(r => r.id);
  const badOrder = ['R-048', ...activeIds.filter(id => id !== 'R-048')];

  const reorderRes = await api('/api/dependencies/reorder', {
    method: 'POST',
    body: JSON.stringify({ orderedRuleIds: badOrder })
  });
  assert.equal(reorderRes.status, 400);
  assert.equal(reorderRes.body.valid, false);
  assert.ok(reorderRes.body.error.includes('Kötelező függőség sérülése'));

  // 3. Downstream Impact Analysis on R-011 (felulet_m2)
  const impactRes = await api('/api/dependencies/impact/R-011');
  assert.equal(impactRes.status, 200);
  assert.ok(impactRes.body.directDependents.includes('R-019'));
  assert.ok(impactRes.body.allAffectedRuleIds.includes('R-048'), 'R-048 (gyarthato) transitively depends on R-011 (felulet_m2)');
  assert.ok(impactRes.body.allAffectedRuleIds.includes('R-080'), 'R-080 (vegso_minosites) transitively depends on R-011');
});

test('SC-03, Section 8 & 15: Natural language AI rule synthesis, Decision Tables, Safe Expressions, and SQL injection guardrail', async () => {
  // 1. AI NL Rule Proposal via API
  const aiRes = await api('/api/rules/ai-propose', {
    method: 'POST',
    body: JSON.stringify({
      prompt: 'Ha a kedvezmény meghaladja a 15 százalékot, akkor kérjen felülvizsgálatot (Requires Review).'
    })
  });
  assert.equal(aiRes.status, 200);
  assert.equal(aiRes.body.proposedRule.lifecycleStatus, 'Draft', 'AI proposal must always start in Draft');
  assert.equal(aiRes.body.proposedRule.output.onFalseStatus, 'Requires Review');
  assert.equal(aiRes.body.suggestedTests.length, 6, 'AI should suggest 6 categorized test cases');
  assert.ok(aiRes.body.suggestedTests.every(t => t.userConfirmed === false), 'User must confirm expected outcomes');

  // 2. Guardrail against raw SQL injection in structured rule validation
  const maliciousRule = {
    id: 'R-SQL-BAD',
    name: 'Bad SQL Rule',
    output: { outputField: 'bad_out' },
    conditions: { combinator: 'AND', rules: [{ field: 'x', operator: '==', value: 'DROP TABLE users' }] }
  };
  const valCheck = validateRuleStructure(maliciousRule);
  assert.equal(valCheck.valid, false);
  assert.ok(valCheck.errors[0].includes('SQL'));
});

test('SC-05 & SC-06: User test case execution and strict Approval Gate before Prod promotion', async () => {
  // 1. Run all test cases (T01..T06)
  const runTestsRes = await api('/api/tests/run', {
    method: 'POST',
    body: JSON.stringify({ markRulesValidated: false })
  });
  assert.equal(runTestsRes.status, 200);
  assert.equal(runTestsRes.body.allPassed, true, 'All seeded user test cases T01..T06 must pass');

  // 2. Attempt to promote Draft & Untested rule R-083 directly to Prod -> MUST BE BLOCKED (SC-06)
  const blockedPromo = await api('/api/rules/R-083/lifecycle', {
    method: 'POST',
    body: JSON.stringify({
      targetStatus: 'Prod',
      approvedBy: 'Kovács Anna'
    })
  });
  assert.equal(blockedPromo.status, 400);
  assert.ok(blockedPromo.body.error.includes('SC-06'));

  // 3. Validate tests and promote R-081 (Test, Passed) to Prod -> MUST SUCCEED and archive version
  const validPromo = await api('/api/rules/R-081/lifecycle', {
    method: 'POST',
    body: JSON.stringify({
      targetStatus: 'Prod',
      approvedBy: 'Kovács Anna (Üzleti Szabálygazda)',
      approvalNote: 'Tesztesetek alapján jóváhagyva.'
    })
  });
  assert.equal(validPromo.status, 200);
  assert.equal(validPromo.body.rule.lifecycleStatus, 'Prod');

  // Check preserved version history
  const verRes = await api('/api/rules/R-081/versions');
  assert.equal(verRes.status, 200);
  assert.ok(verRes.body.versions.length >= 1);
});

test('SC-07 & SC-11: Deterministic Execution Engine reproducibility and Non-Destructive source guarantee', async () => {
  const exec1 = await api('/api/execute', {
    method: 'POST',
    body: JSON.stringify({ mode: 'prod', actor: 'Teszt Mérnök' })
  });
  const exec2 = await api('/api/execute', {
    method: 'POST',
    body: JSON.stringify({ mode: 'prod', actor: 'Teszt Mérnök' })
  });

  assert.equal(exec1.status, 200);
  assert.equal(exec2.status, 200);

  // SC-07: Identical input + identical rule configuration = identical output hash
  assert.equal(exec1.body.deterministicOutputHash, exec2.body.deterministicOutputHash);

  // SC-11: Source data SHA-256 before and after execution must be 100% identical
  assert.equal(exec1.body.sourceDataUnchanged, true);
  assert.equal(exec1.body.sourceHashBefore, exec1.body.sourceHashAfter);
});

test('SC-09, SC-11 & SC-12: Record-level rule explanations and non-destructive Human Verification override', async () => {
  // 1. Inspect record #1003 explanation trace
  const traceRes = await api('/api/results/1003');
  assert.equal(traceRes.status, 200);
  assert.equal(traceRes.body.finalStatus, 'Requires Review');
  assert.ok(traceRes.body.ruleTraces.length >= 80, 'Record trace should contain all executed Prod rules');

  // 2. Submit a Human Verification Override on record #1015
  const revRes = await api('/api/reviews', {
    method: 'POST',
    body: JSON.stringify({
      recordId: '1015',
      decision: 'Approved Exception',
      comment: 'Építési helyszínre történő közvetlen kiszállítás igazolt.',
      reviewedBy: 'Nagy Gábor'
    })
  });
  assert.equal(revRes.status, 201);
  assert.equal(revRes.body.review.originalRuleStatus, 'Requires Review');
  assert.equal(revRes.body.review.decision, 'Approved Exception');

  // Verify original rule status on record #1015 is STILL 'Requires Review' (non-destructive override!)
  const afterTrace = await api('/api/results/1015');
  assert.equal(afterTrace.body.finalStatus, 'Requires Review');
  assert.equal(afterTrace.body.humanReviews[0].decision, 'Approved Exception');
});

test('SC-10: Excel (.xlsx) and UTF-8 CSV (.csv) export and round-trip parsing', async () => {
  // 1. Test CSV export endpoint
  const csvRes = await api('/api/export/csv');
  assert.equal(csvRes.status, 200);
  const csvString = csvRes.buffer.toString('utf8');
  assert.ok(csvString.startsWith('\uFEFF'), 'CSV export must include UTF-8 BOM for Hungarian Excel');
  const parsedCsvRows = parseCsv(csvString);
  assert.equal(parsedCsvRows.length, 105);
  assert.equal(String(parsedCsvRows[0].Rekord_ID), '1001');
  assert.equal(parsedCsvRows[0].Gyártható, 'Igen');

  // 2. Test XLSX export endpoint and round-trip parseXlsxBuffer
  const xlsxRes = await api('/api/export/xlsx');
  assert.equal(xlsxRes.status, 200);
  const parsedXlsxRows = parseXlsxBuffer(xlsxRes.buffer);
  assert.equal(parsedXlsxRows.length, 105);
  assert.equal(String(parsedXlsxRows[0].Rekord_ID), '1001');
  assert.equal(parsedXlsxRows[1].Gyártható, 'Nem');
  assert.equal(parsedXlsxRows[2].Címellenőrzés, 'Review');
});

test('SC-01 End-to-End: Configure a brand new Use Case without code, add rule, validate, approve, and execute', async () => {
  const newUcRes = await api('/api/use-cases', {
    method: 'POST',
    body: JSON.stringify({
      id: 'UC-SUPPLIER-CHECK',
      name: 'Beszállítói Ár- és Tanúsítvány Ellenőrzés',
      primaryKey: 'tetel_id',
      initialRecords: [
        { tetel_id: 'SUP-01', beszallito: 'G-U Kft.', ar_eur: 15, tanusitvany: 'ISO-9001' },
        { tetel_id: 'SUP-02', beszallito: 'Import Bt.', ar_eur: 180, tanusitvany: 'NINCS' }
      ]
    })
  });
  assert.equal(newUcRes.status, 201);
  assert.equal(newUcRes.body.useCase.id, 'UC-SUPPLIER-CHECK');

  // Create a rule in the new Use Case
  const ruleRes = await api('/api/rules?useCaseId=UC-SUPPLIER-CHECK', {
    method: 'POST',
    body: JSON.stringify({
      id: 'SUP-R01',
      name: 'ISO-9001 tanúsítvány megléte',
      category: 'Minőségbiztosítás',
      ruleType: 'visual_condition',
      conditions: {
        combinator: 'AND',
        rules: [{ field: 'tanusitvany', operator: '==', value: 'ISO-9001' }]
      },
      output: {
        outputField: 'tanusitvany_ok',
        outputType: 'classification',
        trueValue: 'OK',
        falseValue: 'Hiányzik',
        onTrueStatus: 'Accepted',
        onFalseStatus: 'Error',
        passMessage: 'ISO-9001 tanúsítvány rendben.',
        failMessage: 'Hiányzó ISO-9001 tanúsítvány!'
      }
    })
  });
  assert.equal(ruleRes.status, 201);

  // Add a user test case and run it to validate SUP-R01
  await api('/api/tests?useCaseId=UC-SUPPLIER-CHECK', {
    method: 'POST',
    body: JSON.stringify({
      testCode: 'SUP-T01',
      name: 'Érvényes ISO tanúsítvány teszt',
      inputData: { tetel_id: 'SUP-01', beszallito: 'G-U Kft.', ar_eur: 15, tanusitvany: 'ISO-9001' },
      expectedStatus: 'Accepted',
      expectedOutputs: {}
    })
  });

  const testRunRes = await api('/api/tests/run?useCaseId=UC-SUPPLIER-CHECK', {
    method: 'POST',
    body: JSON.stringify({ includeTestRules: true, markRulesValidated: true })
  });
  assert.equal(testRunRes.body.allPassed, true);

  // Approve SUP-R01 to Prod
  const promoRes = await api('/api/rules/SUP-R01/lifecycle?useCaseId=UC-SUPPLIER-CHECK', {
    method: 'POST',
    body: JSON.stringify({
      targetStatus: 'Prod',
      approvedBy: 'Kovács Anna (Üzleti Szabálygazda)'
    })
  });
  assert.equal(promoRes.status, 200);
  assert.equal(promoRes.body.rule.lifecycleStatus, 'Prod');

  // Execute deterministic pipeline on UC-SUPPLIER-CHECK
  const execRes = await api('/api/execute?useCaseId=UC-SUPPLIER-CHECK', {
    method: 'POST',
    body: JSON.stringify({ mode: 'prod' })
  });
  assert.equal(execRes.status, 200);
  assert.equal(execRes.body.recordCount, 2);
  assert.equal(execRes.body.statusCounts['Accepted'], 1);
  assert.equal(execRes.body.statusCounts['Error'], 1);
});

test('SC-01 & Section 20: Full Self-Check endpoint verifies all 12 Success Criteria (SC-01 .. SC-12)', async () => {
  await api('/api/tests/run?useCaseId=UC-WINDOW-ORDERS', {
    method: 'POST',
    body: JSON.stringify({ markRulesValidated: true })
  });

  const checkRes = await api('/api/verification/self-check');
  assert.equal(checkRes.status, 200);
  assert.equal(checkRes.body.totalCriteria, 12);
  assert.equal(checkRes.body.passedCount, 12);
  assert.equal(checkRes.body.allPassed, true);
});

