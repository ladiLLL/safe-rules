'use strict';

/**
 * Custom error class to strictly separate technical execution errors
 * from business rule errors/warnings (Specification Section 11 & 12).
 */
class TechnicalRuleExecutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TechnicalRuleExecutionError';
    this.isTechnicalError = true;
    this.details = details;
  }
}

const VALID_LIFECYCLE_STATUSES = ['Draft', 'Test', 'Prod', 'Retired'];
const VALID_RECORD_STATUSES = ['Accepted', 'Warning', 'Requires Review', 'Error', 'Execution Failed'];
const STATUS_SEVERITY = {
  'Accepted': 0,
  'Warning': 1,
  'Requires Review': 2,
  'Error': 3,
  'Execution Failed': 4
};

/**
 * Resolves a field value from the unified evaluation context (source + joined + rule outputs + aggregations)
 */
function resolveFieldValue(context, fieldPath) {
  if (fieldPath === null || fieldPath === undefined) return undefined;
  const key = String(fieldPath).trim();
  if (Object.prototype.hasOwnProperty.call(context, key)) {
    return context[key];
  }
  // Support dot notation for joined objects e.g. "ref_contract.szerzodeses_cim"
  if (key.includes('.')) {
    const parts = key.split('.');
    let cur = context;
    for (const p of parts) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
      cur = cur[p];
    }
    return cur;
  }
  return undefined;
}

function isNullOrEmpty(val) {
  return val === null || val === undefined || (typeof val === 'string' && val.trim() === '');
}

function toNumberStrict(val, fieldName) {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new TechnicalRuleExecutionError(`Érvénytelen numerikus érték (NaN/Infinity) a(z) '${fieldName}' mezőben.`, { fieldName, val });
    }
    return val;
  }
  if (typeof val === 'string' && val.trim() !== '') {
    const num = Number(val.trim());
    if (!Number.isNaN(num) && Number.isFinite(num)) return num;
  }
  throw new TechnicalRuleExecutionError(`Technikai típuskonverziós hiba: a(z) '${fieldName}' mező értéke ('${val}') nem alakítható számmá.`, { fieldName, val });
}

/**
 * Evaluates a single atomic condition leaf against record context.
 * Returns { matched: boolean, actualValue, comparedAgainst, traceText }
 */
function evaluateAtomicCondition(cond, context) {
  const field = cond.field;
  const op = (cond.operator || '==').toLowerCase();
  const actual = resolveFieldValue(context, field);
  let target = cond.value;

  // Check if comparing against another field
  if (cond.valueFromField || op.endsWith('_field')) {
    const otherField = cond.valueFromField || cond.value;
    target = resolveFieldValue(context, otherField);
  }

  let matched = false;

  switch (op) {
    case 'is_null':
    case 'empty':
      matched = isNullOrEmpty(actual);
      break;

    case 'is_not_null':
    case 'not_empty':
      matched = !isNullOrEmpty(actual);
      break;

    case '==':
    case 'eq':
    case 'equals':
    case 'equals_field':
      if (typeof actual === 'number' || typeof target === 'number') {
        matched = !isNullOrEmpty(actual) && !isNullOrEmpty(target) && Number(actual) === Number(target);
      } else if (typeof actual === 'boolean' || typeof target === 'boolean') {
        matched = String(actual).toLowerCase() === String(target).toLowerCase();
      } else {
        matched = String(actual ?? '').trim() === String(target ?? '').trim();
      }
      break;

    case '!=':
    case 'neq':
    case 'not_equals':
    case 'not_equals_field':
      if (typeof actual === 'number' || typeof target === 'number') {
        matched = isNullOrEmpty(actual) || isNullOrEmpty(target) || Number(actual) !== Number(target);
      } else if (typeof actual === 'boolean' || typeof target === 'boolean') {
        matched = String(actual).toLowerCase() !== String(target).toLowerCase();
      } else {
        matched = String(actual ?? '').trim() !== String(target ?? '').trim();
      }
      break;

    case '>':
    case 'gt':
    case 'gt_field': {
      if (isNullOrEmpty(actual) || isNullOrEmpty(target)) {
        matched = false;
      } else {
        matched = toNumberStrict(actual, field) > toNumberStrict(target, cond.valueFromField || 'target');
      }
      break;
    }

    case '>=':
    case 'gte':
    case 'gte_field': {
      if (isNullOrEmpty(actual) || isNullOrEmpty(target)) {
        matched = false;
      } else {
        matched = toNumberStrict(actual, field) >= toNumberStrict(target, cond.valueFromField || 'target');
      }
      break;
    }

    case '<':
    case 'lt':
    case 'lt_field': {
      if (isNullOrEmpty(actual) || isNullOrEmpty(target)) {
        matched = false;
      } else {
        matched = toNumberStrict(actual, field) < toNumberStrict(target, cond.valueFromField || 'target');
      }
      break;
    }

    case '<=':
    case 'lte':
    case 'lte_field': {
      if (isNullOrEmpty(actual) || isNullOrEmpty(target)) {
        matched = false;
      } else {
        matched = toNumberStrict(actual, field) <= toNumberStrict(target, cond.valueFromField || 'target');
      }
      break;
    }

    case 'between': {
      if (isNullOrEmpty(actual)) {
        matched = false;
      } else {
        const num = toNumberStrict(actual, field);
        let minVal, maxVal;
        if (Array.isArray(target)) {
          [minVal, maxVal] = target;
        } else if (typeof target === 'object' && target !== null) {
          minVal = target.min;
          maxVal = target.max;
        } else if (typeof target === 'string' && target.includes('..')) {
          [minVal, maxVal] = target.split('..').map(s => s.trim());
        } else if (typeof target === 'string' && target.includes(',')) {
          [minVal, maxVal] = target.split(',').map(s => s.trim());
        }
        matched = num >= toNumberStrict(minVal, 'min') && num <= toNumberStrict(maxVal, 'max');
      }
      break;
    }

    case 'in': {
      const list = Array.isArray(target)
        ? target.map(x => String(x).trim())
        : String(target ?? '').split(',').map(x => x.trim()).filter(Boolean);
      matched = !isNullOrEmpty(actual) && list.includes(String(actual).trim());
      break;
    }

    case 'not_in': {
      const list = Array.isArray(target)
        ? target.map(x => String(x).trim())
        : String(target ?? '').split(',').map(x => x.trim()).filter(Boolean);
      matched = isNullOrEmpty(actual) || !list.includes(String(actual).trim());
      break;
    }

    case 'contains':
      matched = !isNullOrEmpty(actual) && String(actual).toLowerCase().includes(String(target ?? '').toLowerCase());
      break;

    case 'not_contains':
      matched = isNullOrEmpty(actual) || !String(actual).toLowerCase().includes(String(target ?? '').toLowerCase());
      break;

    case 'starts_with':
      matched = !isNullOrEmpty(actual) && String(actual).toLowerCase().startsWith(String(target ?? '').toLowerCase());
      break;

    case 'ends_with':
      matched = !isNullOrEmpty(actual) && String(actual).toLowerCase().endsWith(String(target ?? '').toLowerCase());
      break;

    case 'matches_regex': {
      if (isNullOrEmpty(actual)) {
        matched = false;
      } else {
        try {
          const rx = new RegExp(String(target));
          matched = rx.test(String(actual));
        } catch (err) {
          throw new TechnicalRuleExecutionError(`Érvénytelen reguláris kifejezés: ${target}`, { regex: target });
        }
      }
      break;
    }

    case 'lookup_exists':
      matched = actual !== null && actual !== undefined && actual !== false && actual !== 'MISSING';
      break;

    case 'lookup_missing':
      matched = actual === null || actual === undefined || actual === false || actual === 'MISSING';
      break;

    default:
      throw new TechnicalRuleExecutionError(`Ismeretlen feltétel-operátor: '${cond.operator}'`, { operator: cond.operator });
  }

  if (cond.negate) {
    matched = !matched;
  }

  return {
    matched,
    field,
    operator: cond.operator,
    actualValue: actual,
    expectedValue: target,
    traceText: `${field} [${actual ?? 'NULL'}] ${cond.negate ? 'NOT ' : ''}${cond.operator} ${JSON.stringify(target)} => ${matched ? 'IGAZ' : 'HAMIS'}`
  };
}

/**
 * Evaluates a recursive condition tree ({ combinator: 'AND'|'OR'|'NOT', rules: [...] })
 */
function evaluateConditionGroup(group, context) {
  if (!group) {
    return { matched: true, traces: [] };
  }

  // Leaf condition node
  if (group.field && !group.rules && !group.conditions) {
    const res = evaluateAtomicCondition(group, context);
    return { matched: res.matched, traces: [res] };
  }

  const children = group.rules || group.conditions || [];
  if (children.length === 0) {
    return { matched: true, traces: [] };
  }

  const combinator = (group.combinator || group.logic || 'AND').toUpperCase();
  const childResults = children.map(child => evaluateConditionGroup(child, context));
  const allTraces = childResults.flatMap(r => r.traces);

  let matched = false;
  if (combinator === 'AND') {
    matched = childResults.every(r => r.matched);
  } else if (combinator === 'OR') {
    matched = childResults.some(r => r.matched);
  } else if (combinator === 'NOT') {
    matched = !childResults.every(r => r.matched);
  } else {
    throw new TechnicalRuleExecutionError(`Ismeretlen logikai kombinátor: '${combinator}'`);
  }

  if (group.negate) {
    matched = !matched;
  }

  return { matched, traces: allTraces };
}

/**
 * Evaluates a cell condition inside a Decision Table
 */
function evaluateDecisionCell(cellRule, actualValue, fieldName) {
  if (cellRule === null || cellRule === undefined || cellRule === '' || cellRule === '*' || cellRule === '-') {
    return true; // Wildcard ("don't care")
  }
  const strRule = String(cellRule).trim();
  if (strRule === '*' || strRule === '-' || strRule.toUpperCase() === 'ANY') {
    return true;
  }

  // Range syntax: [100..2400] or 100..2400
  const rangeMatch = /^\[?\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*\]?$/.exec(strRule);
  if (rangeMatch) {
    if (isNullOrEmpty(actualValue)) return false;
    const num = toNumberStrict(actualValue, fieldName);
    return num >= Number(rangeMatch[1]) && num <= Number(rangeMatch[2]);
  }

  // Comparator prefix syntax: >= 100, <= 500, > 0, < 10, != Nem
  const compMatch = /^(>=|<=|!=|>|<|==)\s*(.+)$/.exec(strRule);
  if (compMatch) {
    return evaluateAtomicCondition(
      { field: fieldName, operator: compMatch[1], value: compMatch[2] },
      { [fieldName]: actualValue }
    ).matched;
  }

  // Comma-separated list syntax: "PVC, Alu"
  if (strRule.includes(',')) {
    const items = strRule.split(',').map(s => s.trim());
    return !isNullOrEmpty(actualValue) && items.includes(String(actualValue).trim());
  }

  // Direct equality
  return evaluateAtomicCondition(
    { field: fieldName, operator: '==', value: cellRule },
    { [fieldName]: actualValue }
  ).matched;
}

/**
 * Evaluates a Decision Table rule
 */
function evaluateDecisionTable(decisionTable, context) {
  const inputs = decisionTable.inputs || [];
  const rows = decisionTable.rows || [];
  const hitPolicy = (decisionTable.hitPolicy || 'FIRST').toUpperCase();
  const matchedRows = [];
  const traces = [];

  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx];
    const conditions = row.conditions || row.inputs || {};
    let rowMatched = true;
    const rowTraceParts = [];

    for (const inputCol of inputs) {
      const field = typeof inputCol === 'string' ? inputCol : inputCol.field;
      const cellRule = Array.isArray(conditions)
        ? conditions[inputs.indexOf(inputCol)]
        : conditions[field];
      const actual = resolveFieldValue(context, field);
      const cellOk = evaluateDecisionCell(cellRule, actual, field);
      rowTraceParts.push(`${field}(${actual ?? 'NULL'}) vs '${cellRule ?? '*'}'=${cellOk ? 'OK' : 'X'}`);
      if (!cellOk) {
        rowMatched = false;
        break;
      }
    }

    if (rowMatched) {
      matchedRows.push({ index: rIdx + 1, row });
      traces.push({
        matched: true,
        field: `DecisionRow#${rIdx + 1}`,
        operator: 'DECISION_ROW',
        actualValue: rowTraceParts.join(', '),
        expectedValue: row.outputValue ?? row.value,
        traceText: `Döntési tábla #${rIdx + 1}. sor illeszkedett: ${rowTraceParts.join(' & ')}`
      });
      if (hitPolicy === 'FIRST' || hitPolicy === 'UNIQUE') {
        break;
      }
    }
  }

  if (matchedRows.length > 0) {
    if (hitPolicy === 'COLLECT') {
      return {
        matched: true,
        outputValue: matchedRows.map(m => m.row.outputValue ?? m.row.value),
        statusEffect: matchedRows[0].row.statusEffect || null,
        reason: matchedRows.map(m => m.row.reason).filter(Boolean).join('; '),
        traces
      };
    }
    const chosen = matchedRows[0].row;
    return {
      matched: true,
      outputValue: chosen.outputValue ?? chosen.value,
      statusEffect: chosen.statusEffect || null,
      reason: chosen.reason || null,
      traces
    };
  }

  // Fallback default row
  const def = decisionTable.defaultOutcome || {};
  traces.push({
    matched: false,
    field: 'DecisionDefault',
    operator: 'DEFAULT',
    actualValue: 'Nincs illeszkedő sor',
    expectedValue: def.outputValue ?? true,
    traceText: `Döntési tábla alapértelmezett ág (nincs illeszkedő sor) => ${def.outputValue ?? 'OK'}`
  });

  return {
    matched: false,
    outputValue: def.outputValue !== undefined ? def.outputValue : true,
    statusEffect: def.statusEffect || 'Accepted',
    reason: def.reason || 'Alapértelmezett döntési tábla ág',
    traces
  };
}

/**
 * Safe deterministic expression evaluator (NO arbitrary JS eval or raw SQL).
 * Supports arithmetic (+, -, *, /), comparisons, IF(cond, thenVal, elseVal),
 * ROUND(val, decimals), MIN(a,b), MAX(a,b), ABS(x), CONCAT(...), COALESCE(a,b).
 */
function evaluateSafeExpression(exprStr, context) {
  if (!exprStr || typeof exprStr !== 'string') {
    throw new TechnicalRuleExecutionError('Üres vagy érvénytelen kifejezés a szabályban.');
  }

  // Tokenize expression into a safe AST
  const tokens = tokenizeExpression(exprStr.trim());
  let pos = 0;

  function peek() {
    return tokens[pos];
  }
  function consume(expectedType, expectedVal) {
    const t = tokens[pos];
    if (!t) throw new TechnicalRuleExecutionError(`Váratlan kifejezés-vég: '${exprStr}'`);
    if (expectedType && t.type !== expectedType) {
      throw new TechnicalRuleExecutionError(`Szintaktikai hiba a kifejezésben: várt ${expectedType}, kapott ${t.type} (${t.value})`);
    }
    if (expectedVal && t.value !== expectedVal) {
      throw new TechnicalRuleExecutionError(`Szintaktikai hiba a kifejezésben: várt '${expectedVal}', kapott '${t.value}'`);
    }
    pos++;
    return t;
  }

  function parseExpression() {
    return parseLogicalOr();
  }

  function parseLogicalOr() {
    let left = parseLogicalAnd();
    while (peek() && (peek().value === 'OR' || peek().value === '||')) {
      consume();
      const right = parseLogicalAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  function parseLogicalAnd() {
    let left = parseComparison();
    while (peek() && (peek().value === 'AND' || peek().value === '&&')) {
      consume();
      const right = parseComparison();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  function parseComparison() {
    let left = parseAdditive();
    while (peek() && ['==', '!=', '>', '>=', '<', '<='].includes(peek().value)) {
      const op = consume().value;
      const right = parseAdditive();
      if (op === '==') left = left == right;
      else if (op === '!=') left = left != right;
      else if (op === '>') left = toNumberStrict(left, 'expr_left') > toNumberStrict(right, 'expr_right');
      else if (op === '>=') left = toNumberStrict(left, 'expr_left') >= toNumberStrict(right, 'expr_right');
      else if (op === '<') left = toNumberStrict(left, 'expr_left') < toNumberStrict(right, 'expr_right');
      else if (op === '<=') left = toNumberStrict(left, 'expr_left') <= toNumberStrict(right, 'expr_right');
    }
    return left;
  }

  function parseAdditive() {
    let left = parseMultiplicative();
    while (peek() && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const right = parseMultiplicative();
      if (op === '+') {
        if (typeof left === 'string' || typeof right === 'string') {
          left = String(left ?? '') + String(right ?? '');
        } else {
          left = toNumberStrict(left, 'add_left') + toNumberStrict(right, 'add_right');
        }
      } else {
        left = toNumberStrict(left, 'sub_left') - toNumberStrict(right, 'sub_right');
      }
    }
    return left;
  }

  function parseMultiplicative() {
    let left = parseUnary();
    while (peek() && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = consume().value;
      const right = parseUnary();
      const lNum = toNumberStrict(left, 'mul_left');
      const rNum = toNumberStrict(right, 'mul_right');
      if (op === '*') {
        left = lNum * rNum;
      } else if (op === '/') {
        if (rNum === 0) {
          throw new TechnicalRuleExecutionError(`Nullával való osztás technikai hiba a kifejezésben: '${exprStr}'`, { expression: exprStr });
        }
        left = lNum / rNum;
      } else {
        if (rNum === 0) {
          throw new TechnicalRuleExecutionError(`Nullával való maradékos osztás technikai hiba: '${exprStr}'`, { expression: exprStr });
        }
        left = lNum % rNum;
      }
    }
    return left;
  }

  function parseUnary() {
    if (peek() && peek().value === '-') {
      consume();
      return -toNumberStrict(parseUnary(), 'unary_minus');
    }
    if (peek() && (peek().value === 'NOT' || peek().value === '!')) {
      consume();
      return !Boolean(parseUnary());
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw new TechnicalRuleExecutionError(`Hiányzó operandus a kifejezésben: '${exprStr}'`);

    if (t.type === 'NUMBER') {
      consume();
      return t.value;
    }
    if (t.type === 'STRING') {
      consume();
      return t.value;
    }
    if (t.type === 'BOOLEAN') {
      consume();
      return t.value;
    }
    if (t.type === 'PUNCT' && t.value === '(') {
      consume('PUNCT', '(');
      const val = parseExpression();
      consume('PUNCT', ')');
      return val;
    }
    if (t.type === 'IDENT') {
      const name = consume().value;
      // Check if function call
      if (peek() && peek().type === 'PUNCT' && peek().value === '(') {
        consume('PUNCT', '(');
        const args = [];
        if (!(peek() && peek().type === 'PUNCT' && peek().value === ')')) {
          args.push(parseExpression());
          while (peek() && peek().type === 'PUNCT' && peek().value === ',') {
            consume('PUNCT', ',');
            args.push(parseExpression());
          }
        }
        consume('PUNCT', ')');
        return invokeBuiltinFunction(name.toUpperCase(), args, context);
      }
      // Otherwise resolve variable from context
      return resolveFieldValue(context, name);
    }

    throw new TechnicalRuleExecutionError(`Érvénytelen token a kifejezésben: ${JSON.stringify(t)}`);
  }

  const result = parseExpression();
  if (pos < tokens.length) {
    throw new TechnicalRuleExecutionError(`Nem várt token a kifejezés végén: '${tokens[pos].value}'`);
  }
  return result;
}

function invokeBuiltinFunction(fnName, args, context) {
  switch (fnName) {
    case 'IF':
      return Boolean(args[0]) ? args[1] : args[2];
    case 'ROUND': {
      const num = toNumberStrict(args[0], 'ROUND_arg0');
      const dec = args[1] !== undefined ? Number(args[1]) : 0;
      const factor = Math.pow(10, dec);
      return Math.round((num + Number.EPSILON) * factor) / factor;
    }
    case 'MIN':
      return Math.min(...args.map((a, i) => toNumberStrict(a, `MIN_arg${i}`)));
    case 'MAX':
      return Math.max(...args.map((a, i) => toNumberStrict(a, `MAX_arg${i}`)));
    case 'ABS':
      return Math.abs(toNumberStrict(args[0], 'ABS_arg0'));
    case 'CONCAT':
      return args.map(a => String(a ?? '')).join('');
    case 'COALESCE':
      return args.find(a => a !== null && a !== undefined && a !== '') ?? null;
    case 'UPPER':
      return String(args[0] ?? '').toUpperCase();
    case 'LOWER':
      return String(args[0] ?? '').toLowerCase();
    case 'LEN':
      return String(args[0] ?? '').length;
    default:
      throw new TechnicalRuleExecutionError(`Ismeretlen függvény a kifejezésben: '${fnName}()'`);
  }
}

function tokenizeExpression(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let s = '';
      while (i < str.length && str[i] !== quote) {
        if (str[i] === '\\' && i + 1 < str.length) {
          i++;
        }
        s += str[i++];
      }
      i++; // skip closing quote
      tokens.push({ type: 'STRING', value: s });
      continue;
    }
    if (/\d/.test(ch)) {
      let numStr = '';
      while (i < str.length && /[\d.]/.test(str[i])) {
        numStr += str[i++];
      }
      tokens.push({ type: 'NUMBER', value: Number(numStr) });
      continue;
    }
    const twoChar = str.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(twoChar)) {
      tokens.push({ type: 'OP', value: twoChar });
      i += 2;
      continue;
    }
    if (['+', '-', '*', '/', '%', '>', '<', '!'].includes(ch)) {
      tokens.push({ type: 'OP', value: ch });
      i++;
      continue;
    }
    if (['(', ')', ','].includes(ch)) {
      tokens.push({ type: 'PUNCT', value: ch });
      i++;
      continue;
    }
    if (/[a-zA-Z_áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/.test(ch)) {
      let ident = '';
      while (i < str.length && /[a-zA-Z0-9_.:áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/.test(str[i])) {
        ident += str[i++];
      }
      const upper = ident.toUpperCase();
      if (upper === 'TRUE') {
        tokens.push({ type: 'BOOLEAN', value: true });
      } else if (upper === 'FALSE') {
        tokens.push({ type: 'BOOLEAN', value: false });
      } else if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
        tokens.push({ type: 'OP', value: upper });
      } else {
        tokens.push({ type: 'IDENT', value: ident });
      }
      continue;
    }
    throw new TechnicalRuleExecutionError(`Érvénytelen karakter a kifejezésben: '${ch}' (pozíció: ${i})`);
  }
  return tokens;
}

/**
 * Evaluates any rule in the unified structured model against a record context.
 * Returns a standardized RuleEvaluationOutcome:
 * {
 *   ruleId, ruleName, ruleVersion, matched, outputField, outputValue,
 *   recordStatusEffect, message, traces, executionTimeUs
 * }
 */
function evaluateStructuredRule(rule, context) {
  const startHr = process.hrtime.bigint();
  const ruleType = rule.ruleType || 'visual_condition';
  const outputCfg = rule.output || {};
  const outputField = outputCfg.outputField || rule.outputField || `rule_${rule.id}_out`;

  let matched = false;
  let computedValue = null;
  let statusEffect = 'Accepted';
  let explanation = '';
  let traces = [];

  if (ruleType === 'decision_table' && rule.decisionTable) {
    const dtRes = evaluateDecisionTable(rule.decisionTable, context);
    matched = dtRes.matched;
    computedValue = dtRes.outputValue;
    statusEffect = dtRes.statusEffect || (matched ? (outputCfg.onTrueStatus || 'Accepted') : (outputCfg.onFalseStatus || 'Accepted'));
    explanation = dtRes.reason || (matched ? outputCfg.passMessage : outputCfg.failMessage) || rule.description || '';
    traces = dtRes.traces;
  } else if (ruleType === 'expression' || outputCfg.outputType === 'calculated') {
    // Optional pre-condition before expression calculation
    let preCondOk = true;
    if (rule.conditions && ((rule.conditions.rules && rule.conditions.rules.length > 0) || rule.conditions.field)) {
      const condRes = evaluateConditionGroup(rule.conditions, context);
      preCondOk = condRes.matched;
      traces = condRes.traces;
    }
    const exprToRun = preCondOk
      ? (rule.expression || outputCfg.expression)
      : (outputCfg.elseExpression || rule.expression || outputCfg.expression);

    computedValue = evaluateSafeExpression(exprToRun, context);
    matched = Boolean(computedValue);

    // Check optional threshold/status classification on calculated value
    if (outputCfg.errorIfFalse && !matched) {
      statusEffect = outputCfg.onFalseStatus || 'Error';
      explanation = interpolateMessage(outputCfg.failMessage || rule.description, context, computedValue);
    } else {
      statusEffect = outputCfg.onTrueStatus || 'Accepted';
      explanation = interpolateMessage(outputCfg.passMessage || `${outputField} = ${computedValue}`, context, computedValue);
    }
    traces.push({
      matched: true,
      field: outputField,
      operator: 'EXPRESSION',
      actualValue: exprToRun,
      expectedValue: computedValue,
      traceText: `Kifejezés kiértékelve: ${exprToRun} => ${JSON.stringify(computedValue)}`
    });
  } else {
    // Default: visual_condition
    const condRes = evaluateConditionGroup(rule.conditions, context);
    matched = condRes.matched;
    traces = condRes.traces;

    if (matched) {
      computedValue = outputCfg.trueValue !== undefined ? outputCfg.trueValue : true;
      statusEffect = outputCfg.onTrueStatus || 'Accepted';
      explanation = interpolateMessage(outputCfg.passMessage || outputCfg.trueMessage || `${rule.name}: Feltétel teljesült (${computedValue})`, context, computedValue);
    } else {
      computedValue = outputCfg.falseValue !== undefined ? outputCfg.falseValue : false;
      statusEffect = outputCfg.onFalseStatus || 'Accepted';
      explanation = interpolateMessage(outputCfg.failMessage || outputCfg.falseMessage || `${rule.name}: Feltétel nem teljesült (${computedValue})`, context, computedValue);
    }
  }

  const endHr = process.hrtime.bigint();
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    category: rule.category || 'Általános',
    ruleVersion: rule.version || 1,
    ruleType,
    matched,
    outputField,
    outputType: outputCfg.outputType || 'boolean',
    outputValue: computedValue,
    statusEffect,
    explanation,
    traces,
    durationUs: Number((endHr - startHr) / 1000n)
  };
}

function interpolateMessage(template, context, outputValue) {
  if (!template) return '';
  return String(template).replace(/\{([a-zA-Z0-9_.:]+)\}/g, (_, key) => {
    if (key === 'OUT' || key === 'outputValue') return String(outputValue ?? '');
    const v = resolveFieldValue(context, key);
    return v !== undefined && v !== null ? String(v) : 'NULL';
  });
}

/**
 * Extracts all field names referenced in a rule's conditions, decision table, or expression.
 */
function extractReferencedFields(rule) {
  const fields = new Set(Array.isArray(rule.inputFields) ? rule.inputFields : []);

  function walkCond(node) {
    if (!node) return;
    if (node.field) fields.add(node.field);
    if (node.valueFromField) fields.add(node.valueFromField);
    if (typeof node.operator === 'string' && node.operator.endsWith('_field') && typeof node.value === 'string') {
      fields.add(node.value);
    }
    const children = node.rules || node.conditions || [];
    for (const c of children) walkCond(c);
  }

  if (rule.conditions) walkCond(rule.conditions);

  if (rule.decisionTable && Array.isArray(rule.decisionTable.inputs)) {
    for (const inp of rule.decisionTable.inputs) {
      fields.add(typeof inp === 'string' ? inp : inp.field);
    }
  }

  const exprs = [
    rule.expression,
    rule.output && rule.output.expression,
    rule.output && rule.output.elseExpression
  ].filter(Boolean);

  for (const expr of exprs) {
    try {
      const tokens = tokenizeExpression(expr);
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const next = tokens[i + 1];
        if (t.type === 'IDENT' && !(next && next.type === 'PUNCT' && next.value === '(')) {
          fields.add(t.value);
        }
      }
    } catch (_) {
      // Ignore tokenization errors during static extraction
    }
  }

  return Array.from(fields).filter(Boolean);
}

/**
 * Validates that a rule definition conforms to the Unified Structured Rule Model.
 */
function validateRuleStructure(rule) {
  const errors = [];
  if (!rule || typeof rule !== 'object') {
    return { valid: false, errors: ['A szabálynak objektumnak kell lennie.'] };
  }
  if (!rule.id || typeof rule.id !== 'string') {
    errors.push('Hiányzó vagy érvénytelen szabályazonosító (id).');
  }
  if (!rule.name || typeof rule.name !== 'string') {
    errors.push('Hiányzó szabálynév (name).');
  }
  const outputField = (rule.output && rule.output.outputField) || rule.outputField;
  if (!outputField || typeof outputField !== 'string') {
    errors.push('Minden szabálynak kötelező eredménymezőt (output.outputField) definiálnia.');
  }
  if (rule.lifecycleStatus && !VALID_LIFECYCLE_STATUSES.includes(rule.lifecycleStatus)) {
    errors.push(`Érvénytelen életciklus-státusz: ${rule.lifecycleStatus}`);
  }
  // Security guardrail: forbid raw SQL injection keywords in structured rules (Section 8.1)
  const rawJson = JSON.stringify(rule);
  if (/\b(DROP\s+TABLE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|ALTER\s+TABLE|EXEC\s*\()\b/i.test(rawJson)) {
    errors.push('Biztonsági hiba: Nyers, ellenőrizetlen SQL-utasítás nem engedélyezett a strukturált szabálymodellben (Specifikáció 8.1).');
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  TechnicalRuleExecutionError,
  VALID_LIFECYCLE_STATUSES,
  VALID_RECORD_STATUSES,
  STATUS_SEVERITY,
  resolveFieldValue,
  evaluateAtomicCondition,
  evaluateConditionGroup,
  evaluateDecisionTable,
  evaluateSafeExpression,
  evaluateStructuredRule,
  extractReferencedFields,
  validateRuleStructure
};
