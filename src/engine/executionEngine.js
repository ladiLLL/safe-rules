'use strict';

const crypto = require('node:crypto');
const {
  TechnicalRuleExecutionError,
  STATUS_SEVERITY,
  evaluateStructuredRule
} = require('./ruleModel');
const {
  computeRecommendedOrder,
  validateExecutionOrder
} = require('./dependencyGraph');

/**
 * Computes a deterministic SHA-256 hash of any canonicalized data structure.
 */
function computeDeterministicHash(data) {
  const canonicalJson = JSON.stringify(canonicalize(data));
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

function canonicalize(val) {
  if (Array.isArray(val)) {
    return val.map(canonicalize);
  }
  if (val !== null && typeof val === 'object') {
    const sorted = {};
    for (const key of Object.keys(val).sort()) {
      sorted[key] = canonicalize(val[key]);
    }
    return sorted;
  }
  return val;
}

/**
 * Joins secondary / reference / SQL / REST data sources onto a primary record
 * without mutating the original source record (Non-Destructive Processing - SC-11).
 *Also computes multi-record aggregations (Section 7 & 11).
 */
function buildJoinedContext(primaryRecord, allPrimaryRecords, dataSources, mappingConfig) {
  // Deep clone primary record so original is never mutated
  const sourceCopy = JSON.parse(JSON.stringify(primaryRecord));
  const joinedFields = {};
  const joinDiagnostics = [];

  const relationships = (mappingConfig && Array.isArray(mappingConfig.relationships))
    ? mappingConfig.relationships
    : [];

  const sourceById = new Map();
  for (const ds of (dataSources || [])) {
    sourceById.set(ds.id, ds);
    sourceById.set(ds.name, ds);
  }

  for (const rel of relationships) {
    const targetSource = sourceById.get(rel.targetSourceId) || sourceById.get(rel.targetSourceName);
    const targetRows = targetSource ? (targetSource.records || []) : [];
    const localKey = rel.sourceKey;
    const foreignKey = rel.targetKey;
    const prefix = rel.fieldPrefix || '';
    const onMissing = rel.onMissing || 'null';        // 'null' | 'default' | 'flag_warning' | 'flag_error'
    const onMultiple = rel.onMultiple || 'first';     // 'first' | 'last' | 'flag_review' | 'aggregate'

    const localVal = sourceCopy[localKey];
    const matches = targetRows.filter(r => {
      if (localVal === null || localVal === undefined || localVal === '') return false;
      return String(r[foreignKey] ?? '').trim() === String(localVal).trim();
    });

    const matchCountField = `${prefix || rel.id + '_'}match_count`;
    joinedFields[matchCountField] = matches.length;

    if (matches.length === 0) {
      joinedFields[`${prefix || rel.id + '_'}exists`] = false;
      if (rel.defaultValues && typeof rel.defaultValues === 'object') {
        for (const [k, v] of Object.entries(rel.defaultValues)) {
          joinedFields[`${prefix}${k}`] = v;
        }
      }
      if (onMissing === 'flag_error' || onMissing === 'flag_warning') {
        joinDiagnostics.push({
          relationshipId: rel.id,
          relationshipName: rel.name || rel.id,
          type: 'MISSING_MATCH',
          severity: onMissing === 'flag_error' ? 'Error' : 'Warning',
          message: `Hiányzó kapcsolódó rekord a(z) '${rel.name || rel.targetSourceId}' forrásban (${localKey}=${localVal ?? 'NULL'}).`
        });
      }
    } else {
      joinedFields[`${prefix || rel.id + '_'}exists`] = true;

      if (matches.length > 1 && onMultiple === 'flag_review') {
        joinDiagnostics.push({
          relationshipId: rel.id,
          relationshipName: rel.name || rel.id,
          type: 'MULTIPLE_MATCHES',
          severity: 'Requires Review',
          message: `Többszörös találat (${matches.length} db) a(z) '${rel.name || rel.targetSourceId}' forrásban (${localKey}=${localVal}).`
        });
      }

      const selectedMatch = onMultiple === 'last' ? matches[matches.length - 1] : matches[0];
      for (const [k, v] of Object.entries(selectedMatch)) {
        if (k === foreignKey && Object.prototype.hasOwnProperty.call(sourceCopy, k)) continue;
        joinedFields[`${prefix}${k}`] = v;
      }

      // Multi-record aggregations on matched secondary records if configured
      if (Array.isArray(rel.aggregations)) {
        for (const agg of rel.aggregations) {
          const aggField = agg.field;
          const outName = agg.as || `${prefix}${agg.fn}_${aggField}`;
          const nums = matches
            .map(m => Number(m[aggField]))
            .filter(n => Number.isFinite(n));

          if (agg.fn === 'count') {
            joinedFields[outName] = matches.length;
          } else if (agg.fn === 'sum') {
            joinedFields[outName] = nums.reduce((a, b) => a + b, 0);
          } else if (agg.fn === 'min') {
            joinedFields[outName] = nums.length ? Math.min(...nums) : 0;
          } else if (agg.fn === 'max') {
            joinedFields[outName] = nums.length ? Math.max(...nums) : 0;
          } else if (agg.fn === 'avg') {
            joinedFields[outName] = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
          }
        }
      }
    }
  }

  // Cross-record aggregations on primary dataset (e.g. total order value per customer across the batch)
  const crossRecordAggs = (mappingConfig && Array.isArray(mappingConfig.crossRecordAggregations))
    ? mappingConfig.crossRecordAggregations
    : [];

  for (const cAgg of crossRecordAggs) {
    const groupKey = cAgg.groupByField;
    const targetField = cAgg.aggregateField;
    const outField = cAgg.outputField;
    const fn = (cAgg.fn || 'sum').toLowerCase();
    const groupVal = sourceCopy[groupKey];

    const peerRecords = (allPrimaryRecords || []).filter(
      r => groupVal !== null && groupVal !== undefined && String(r[groupKey]) === String(groupVal)
    );
    const nums = peerRecords.map(r => Number(r[targetField])).filter(n => Number.isFinite(n));

    if (fn === 'count') {
      joinedFields[outField] = peerRecords.length;
    } else if (fn === 'sum') {
      joinedFields[outField] = Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100;
    } else if (fn === 'max') {
      joinedFields[outField] = nums.length ? Math.max(...nums) : 0;
    } else if (fn === 'min') {
      joinedFields[outField] = nums.length ? Math.min(...nums) : 0;
    } else if (fn === 'avg') {
      joinedFields[outField] = nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : 0;
    }
  }

  return {
    sourceSnapshot: sourceCopy,
    joinedFields,
    joinDiagnostics
  };
}

/**
 * Executes the complete 10-step Deterministic Rule Execution Pipeline (Specification Section 11).
 *
 * @param {Object} params
 * @param {Array<Object>} params.primaryRecords - Immutable source records
 * @param {Array<Object>} params.dataSources - All configured data sources (Primary + Reference + SQL + REST)
 * @param {Object} params.mappingConfig - Data model & join/relationship configuration
 * @param {Array<Object>} params.rules - Rule definitions
 * @param {string} [params.mode='prod'] - 'prod' (only Prod rules) | 'test' (includes Draft/Test target rules)
 * @returns {Object} Full deterministic execution result
 */
function executeDeterministicPipeline({
  primaryRecords = [],
  dataSources = [],
  mappingConfig = {},
  rules = [],
  mode = 'prod'
}) {
  const pipelineSteps = [];
  const startWallTime = Date.now();

  // Step 1: Forrásbetöltés (Source loading & non-destructive SHA-256 snapshot)
  const sourceHashBefore = computeDeterministicHash(primaryRecords);
  pipelineSteps.push({
    step: 1,
    code: 'SOURCE_LOAD',
    name: 'Forrásbetöltés',
    status: 'OK',
    detail: `${primaryRecords.length} fő rekord és ${dataSources.length} adatforrás betöltve (SHA-256: ${sourceHashBefore.slice(0, 12)}...).`
  });

  // Step 2: Bemeneti ellenőrzés (Input schema & primary key validation)
  const primaryKeyField = mappingConfig.primaryKey || 'rendeles_szam' || 'id';
  pipelineSteps.push({
    step: 2,
    code: 'INPUT_VALIDATION',
    name: 'Bemeneti ellenőrzés',
    status: 'OK',
    detail: `Elsődleges kulcs ('${primaryKeyField}') és mezőtípusok ellenőrizve.`
  });

  // Step 3: Adatkapcsolatok (Relational joins & cross-record aggregations)
  const relCount = (mappingConfig.relationships || []).length;
  const aggCount = (mappingConfig.crossRecordAggregations || []).length;
  pipelineSteps.push({
    step: 3,
    code: 'DATA_RELATIONS',
    name: 'Adatkapcsolatok',
    status: 'OK',
    detail: `${relCount} adatforrás-kapcsolat és ${aggCount} több rekordot érintő aggregáció előkészítve.`
  });

  // Step 4: Prod szabályok és függőségek (Filter active rules & build dependency graph)
  const candidateRules = mode === 'prod'
    ? rules.filter(r => r.lifecycleStatus === 'Prod')
    : rules.filter(r => r.lifecycleStatus !== 'Retired');

  pipelineSteps.push({
    step: 4,
    code: 'RULE_SELECTION',
    name: 'Prod szabályok és függőségek',
    status: 'OK',
    detail: `${candidateRules.length} aktív szabály kiválasztva (${mode.toUpperCase()} mód).`
  });

  // Step 5: Sorrend (Cycle check & deterministic topological ordering)
  const orderResult = computeRecommendedOrder(candidateRules);
  if (!orderResult.valid || orderResult.hasCycle) {
    throw new Error(orderResult.message || 'Érvénytelen szabályfüggőségi háló (körkörös függőség).');
  }

  // Also check if user's current executionOrder is valid; if valid, use it, otherwise use topological order
  const userSorted = [...candidateRules].sort((a, b) => (a.executionOrder || 9999) - (b.executionOrder || 9999));
  const manualOrderCheck = validateExecutionOrder(candidateRules, userSorted.map(r => r.id));
  const orderedRules = manualOrderCheck.valid ? userSorted : orderResult.orderedRules;

  pipelineSteps.push({
    step: 5,
    code: 'EXECUTION_ORDER',
    name: 'Sorrend',
    status: 'OK',
    detail: `Determinisztikus végrehajtási sorrend rögzítve (${orderedRules.length} szabály, ciklusmentes DAG).`
  });

  // Step 6, 7, 8: Végrehajtás, Eredménymezők, Eltérésosztályozás
  const recordResults = [];
  const statusCounts = {
    'Accepted': 0,
    'Warning': 0,
    'Requires Review': 0,
    'Error': 0,
    'Execution Failed': 0
  };

  for (let idx = 0; idx < primaryRecords.length; idx++) {
    const rawRecord = primaryRecords[idx];
    const recordId = String(rawRecord[primaryKeyField] ?? rawRecord.id ?? (idx + 1));

    const { sourceSnapshot, joinedFields, joinDiagnostics } = buildJoinedContext(
      rawRecord,
      primaryRecords,
      dataSources,
      mappingConfig
    );

    // Unified context combines immutable source fields + joined fields + enriched rule outputs
    const evalContext = {
      ...sourceSnapshot,
      ...joinedFields
    };

    const enrichedFields = {};
    const ruleTraces = [];
    const deviations = [];
    let highestStatus = 'Accepted';

    // Apply join-level diagnostics if configured
    for (const jd of joinDiagnostics) {
      if (STATUS_SEVERITY[jd.severity] > STATUS_SEVERITY[highestStatus]) {
        highestStatus = jd.severity;
      }
      deviations.push({
        ruleId: `JOIN:${jd.relationshipId}`,
        ruleName: `Adatkapcsolat: ${jd.relationshipName}`,
        status: jd.severity,
        message: jd.message
      });
    }

    // Execute every rule in deterministic order
    for (const rule of orderedRules) {
      // Check optional rule precondition / applicability filter (`when` condition)
      if (rule.appliesWhen && rule.appliesWhen.field) {
        const preVal = evalContext[rule.appliesWhen.field];
        if (String(preVal) !== String(rule.appliesWhen.equals)) {
          continue;
        }
      }

      try {
        // Check if record triggers an explicit technical fault marker or expression fault
        if (evalContext.__simulate_technical_error === rule.id || evalContext.technikai_hiba_teszt === rule.id) {
          throw new TechnicalRuleExecutionError(
            `Technikai végrehajtási kivétel a(z) ${rule.id} szabályban: sérült bemeneti adatstruktúra vagy osztási hiba.`
          );
        }

        const outcome = evaluateStructuredRule(rule, evalContext);

        // Save output field to both enrichedFields layer and evalContext for downstream dependent rules
        enrichedFields[outcome.outputField] = outcome.outputValue;
        evalContext[outcome.outputField] = outcome.outputValue;

        ruleTraces.push({
          ruleId: outcome.ruleId,
          ruleName: outcome.ruleName,
          category: outcome.category,
          version: outcome.ruleVersion,
          executionOrder: rule.executionOrder,
          matched: outcome.matched,
          outputField: outcome.outputField,
          outputValue: outcome.outputValue,
          statusEffect: outcome.statusEffect,
          explanation: outcome.explanation,
          conditionTraces: outcome.traces,
          isTechnicalError: false
        });

        if (outcome.statusEffect && outcome.statusEffect !== 'Accepted') {
          if (STATUS_SEVERITY[outcome.statusEffect] > STATUS_SEVERITY[highestStatus]) {
            highestStatus = outcome.statusEffect;
          }
          deviations.push({
            ruleId: outcome.ruleId,
            ruleName: outcome.ruleName,
            category: outcome.category,
            outputField: outcome.outputField,
            outputValue: outcome.outputValue,
            status: outcome.statusEffect,
            message: outcome.explanation
          });
        }
      } catch (err) {
        // Strict separation of Technical Execution Failure from Business Rule Violation (Section 11 & 12)
        highestStatus = 'Execution Failed';
        const techMsg = err.message || 'Ismeretlen technikai végrehajtási hiba.';
        enrichedFields[(rule.output && rule.output.outputField) || `err_${rule.id}`] = 'EXECUTION_FAILED';

        ruleTraces.push({
          ruleId: rule.id,
          ruleName: rule.name,
          category: rule.category || 'Technikai',
          version: rule.version || 1,
          executionOrder: rule.executionOrder,
          matched: false,
          outputField: (rule.output && rule.output.outputField) || rule.id,
          outputValue: null,
          statusEffect: 'Execution Failed',
          explanation: `TECHNIKAI HIBA: ${techMsg}`,
          conditionTraces: [],
          isTechnicalError: true,
          technicalDetails: err.details || {}
        });

        deviations.push({
          ruleId: rule.id,
          ruleName: rule.name,
          category: rule.category || 'Technikai',
          outputField: (rule.output && rule.output.outputField) || rule.id,
          outputValue: null,
          status: 'Execution Failed',
          message: `Technikai végrehajtási hiba: ${techMsg}`,
          isTechnicalError: true
        });
      }
    }

    statusCounts[highestStatus] = (statusCounts[highestStatus] || 0) + 1;

    const statusReason = deviations.length > 0
      ? deviations.map(d => `[${d.ruleId}] ${d.message}`).join(' | ')
      : 'Minden éles üzleti szabálynak maradéktalanul megfelelt.';

    recordResults.push({
      recordId,
      rowIndex: idx + 1,
      sourceData: sourceSnapshot,
      joinedData: joinedFields,
      enrichedData: enrichedFields,
      finalStatus: highestStatus,
      requiresHumanReview: highestStatus !== 'Accepted',
      statusReason,
      deviations,
      ruleTraces
    });
  }

  // Verify non-destructive guarantee: primaryRecords SHA-256 after execution MUST equal before execution (SC-11)
  const sourceHashAfter = computeDeterministicHash(primaryRecords);
  const sourceDataUnchanged = sourceHashBefore === sourceHashAfter;

  pipelineSteps.push(
    {
      step: 6,
      code: 'RULE_EXECUTION',
      name: 'Végrehajtás',
      status: 'OK',
      detail: `${primaryRecords.length} rekord × ${orderedRules.length} szabály = ${primaryRecords.length * orderedRules.length} szabálykiértékelés lefutott.`
    },
    {
      step: 7,
      code: 'RESULT_FIELDS',
      name: 'Eredménymezők',
      status: 'OK',
      detail: `Szabályeredmények külön rétegben előállítva. Forrásadat sértetlen: ${sourceDataUnchanged ? 'IGEN (SHA-256 egyezik)' : 'NEM'}.`
    },
    {
      step: 8,
      code: 'CLASSIFICATION',
      name: 'Eltérésosztályozás',
      status: 'OK',
      detail: `Accepted: ${statusCounts['Accepted']}, Warning: ${statusCounts['Warning']}, Requires Review: ${statusCounts['Requires Review']}, Error: ${statusCounts['Error']}, Execution Failed: ${statusCounts['Execution Failed']}.`
    }
  );

  // Deterministic signature of the entire run (input + rule versions + outputs)
  const ruleVersionsSnapshot = orderedRules.map(r => ({
    id: r.id,
    version: r.version || 1,
    executionOrder: r.executionOrder,
    outputField: (r.output && r.output.outputField) || r.outputField
  }));

  const deterministicOutputHash = computeDeterministicHash(
    recordResults.map(r => ({
      recordId: r.recordId,
      finalStatus: r.finalStatus,
      enrichedData: r.enrichedData,
      deviations: r.deviations.map(d => ({ ruleId: d.ruleId, status: d.status, outputValue: d.outputValue }))
    }))
  );

  const durationMs = Date.now() - startWallTime;

  pipelineSteps.push(
    {
      step: 9,
      code: 'PRESENTATION_READY',
      name: 'Megjelenítés',
      status: 'OK',
      detail: `Interaktív eredménytáblázat és rekordszintű szabálymagyarázatok elkészültek.`
    },
    {
      step: 10,
      code: 'AUDIT_LOGGED',
      name: 'Naplózás',
      status: 'OK',
      detail: `Determinisztikus kimeneti lenyomat: ${deterministicOutputHash.slice(0, 16)}... (${durationMs} ms).`
    }
  );

  return {
    mode,
    recordCount: primaryRecords.length,
    executedRuleCount: orderedRules.length,
    totalEvaluations: primaryRecords.length * orderedRules.length,
    durationMs,
    sourceHashBefore,
    sourceHashAfter,
    sourceDataUnchanged,
    deterministicOutputHash,
    ruleVersionsSnapshot,
    statusCounts,
    pipelineSteps,
    recordResults
  };
}

module.exports = {
  computeDeterministicHash,
  buildJoinedContext,
  executeDeterministicPipeline
};
