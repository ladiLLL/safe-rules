'use strict';

const { extractReferencedFields } = require('./ruleModel');
const { buildDependencyGraph, analyzeDownstreamImpact } = require('./dependencyGraph');

/**
 * Natural Language (Hungarian & English) -> Structured Rule Synthesizer.
 * Strictly adheres to Specification Section 8.1 & 15:
 * - Never outputs raw unchecked SQL
 * - Always creates a 'Draft' rule requiring human review, testing, and approval
 * - Automatically detects dependencies and potential contradictions with existing rules
 */
function synthesizeRuleFromNaturalLanguage(promptText, existingRules = [], availableFields = []) {
  const raw = String(promptText || '').trim();
  if (!raw) {
    throw new Error('Kérjük, adja meg az üzleti szabály természetes nyelvű leírását.');
  }

  // Guardrail check: reject raw SQL injection requests
  const sqlAttempt = /\b(SELECT\s+\*\s+FROM|DROP\s+TABLE|DELETE\s+FROM|UPDATE\s+\w+\s+SET|INSERT\s+INTO|EXEC\s+sp_)\b/i.test(raw);
  const sanitizedNote = sqlAttempt
    ? 'FIGYELEM: A Safe Rules AI biztonsági korlátja (Specifikáció 8.1) kiszűrte a közvetlen SQL-utasítást, és helyette determinisztikus strukturált szabálymodellt állított elő.'
    : 'Strukturált szabályjavaslat elkészült természetes nyelvű leírás alapján (Állapot: Draft – emberi ellenőrzés és tesztelés szükséges).';

  const lower = raw.toLowerCase();
  const nextNum = existingRules.length + 1;
  const generatedId = `R-${String(nextNum).padStart(3, '0')}`;

  let name = 'AI által javasolt üzleti szabály';
  let category = 'Általános ellenőrzés';
  let ruleType = 'visual_condition';
  let conditions = { combinator: 'AND', rules: [] };
  let decisionTable = null;
  let expression = null;
  let output = {
    outputField: `ai_szabaly_${nextNum}_eredmeny`,
    outputType: 'boolean',
    trueValue: 'OK',
    falseValue: 'Hiba',
    onTrueStatus: 'Accepted',
    onFalseStatus: 'Error',
    passMessage: 'A feltétel teljesült.',
    failMessage: 'Üzleti feltétel nem teljesült.'
  };

  // Semantic pattern matching for rich Hungarian & English business rules
  if (lower.includes('cím') || lower.includes('szállítási') || lower.includes('address')) {
    name = 'Szállítási és szerződéses cím egyezőség ellenőrzése';
    category = 'Cím és Logisztika';
    conditions = {
      combinator: 'AND',
      rules: [
        { field: 'szallitasi_cim', operator: 'equals_field', valueFromField: 'szerzodeses_cim', value: 'szerzodeses_cim' }
      ]
    };
    output = {
      outputField: 'cimellenorzes',
      outputType: 'classification',
      trueValue: 'OK',
      falseValue: 'Review',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Requires Review',
      passMessage: 'A szállítási cím megegyezik a szerződéses címmel (OK).',
      failMessage: 'A szállítási cím ({szallitasi_cim}) eltér a szerződéses címtől ({szerzodeses_cim}) – felülvizsgálat szükséges.'
    };
  } else if (lower.includes('döntési tábla') || lower.includes('decision table') || (lower.includes('kombináció') && lower.includes('anyag'))) {
    name = 'Anyag, profil és üvegezés kombinációs döntési tábla';
    category = 'Szerkezeti Kompatibilitás';
    ruleType = 'decision_table';
    decisionTable = {
      hitPolicy: 'FIRST',
      inputs: [
        { field: 'termek', label: 'Termék' },
        { field: 'anyag', label: 'Anyag' },
        { field: 'szelesseg_mm', label: 'Szélesség (mm)' }
      ],
      rows: [
        {
          conditions: { termek: 'Door B', anyag: 'PVC', szelesseg_mm: '> 1200' },
          outputValue: 'Nem',
          statusEffect: 'Error',
          reason: 'Door B típus PVC anyaggal 1200 mm felett statikailag nem gyártható.'
        },
        {
          conditions: { termek: 'Window A', anyag: 'PVC, Alu, Fa', szelesseg_mm: '[400..2400]' },
          outputValue: 'Igen',
          statusEffect: 'Accepted',
          reason: 'Engedélyezett Window A méret- és anyagkombináció.'
        },
        {
          conditions: { termek: '*', anyag: 'Alu', szelesseg_mm: '[400..3000]' },
          outputValue: 'Igen',
          statusEffect: 'Accepted',
          reason: 'Alumínium profil nagy fesztávú tartományban gyártható.'
        }
      ],
      defaultOutcome: {
        outputValue: 'Igen',
        statusEffect: 'Accepted',
        reason: 'Alapértelmezett gyártható kombináció.'
      }
    };
    output = {
      outputField: 'kombinacio_gyarthato',
      outputType: 'classification',
      trueValue: 'Igen',
      falseValue: 'Nem',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'A termék-anyag-méret kombináció gyártható.',
      failMessage: 'A termék-anyag-méret kombináció nem gyártható.'
    };
  } else if (lower.includes('felület') || lower.includes('terület') || lower.includes('számít') || lower.includes('képlet') || lower.includes('m2')) {
    name = 'Üvegfelület (m²) számítása méretekből';
    category = 'Geometria és Méretszámítások';
    ruleType = 'expression';
    expression = 'ROUND((szelesseg_mm * magassag_mm) / 1000000, 2)';
    output = {
      outputField: 'szamitott_felulet_m2',
      outputType: 'calculated',
      expression,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Számított felület: {OUT} m².',
      failMessage: 'Számítási hiba.'
    };
  } else if (lower.includes('kedvezmény') || lower.includes('discount') || lower.includes('ár') || lower.includes('hitel')) {
    const numMatch = /(\d+(?:\.\d+)?)/.exec(raw);
    const limit = numMatch ? Number(numMatch[1]) : 15;
    name = `Maximális kedvezmény korlát ellenőrzése (<= ${limit}%)`;
    category = 'Pénzügyi és Szerződéses Szabályok';
    conditions = {
      combinator: 'AND',
      rules: [
        { field: 'kedvezmeny_pct', operator: '<=', value: limit }
      ]
    };
    output = {
      outputField: 'kedvezmeny_statusz',
      outputType: 'classification',
      trueValue: 'OK',
      falseValue: 'Magas kedvezmény',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Requires Review',
      passMessage: `A kedvezmény ({kedvezmeny_pct}%) a megengedett ${limit}% határon belül van.`,
      failMessage: `A kedvezmény ({kedvezmeny_pct}%) meghaladja az engedélyezett ${limit}% határt – vezetői jóváhagyás szükséges.`
    };
  } else {
    // Generic intelligent extraction of field, operator, and numeric/string threshold from prompt
    const numbers = (raw.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    let field = 'szelesseg_mm';
    if (lower.includes('magasság') || lower.includes('height')) field = 'magassag_mm';
    else if (lower.includes('üveg') || lower.includes('glazing')) field = 'uvegezes';
    else if (lower.includes('anyag') || lower.includes('material')) field = 'anyag';
    else if (lower.includes('termék') || lower.includes('product')) field = 'termek';
    else if (lower.includes('keret') || lower.includes('frame')) field = 'keret_vastagsag_mm';
    else if (lower.includes('súly') || lower.includes('weight')) field = 'szarny_terheles_kg';

    const isErrorWhenGreater = lower.includes('nagyobb') || lower.includes('meghalad') || lower.includes('túl nagy') || lower.includes('>');
    const threshold = numbers.length > 0 ? numbers[0] : 2400;

    name = `AI Szabály: ${raw.slice(0, 58)}${raw.length > 58 ? '...' : ''}`;
    category = 'Gyárthatóság és Méretkorlátok';

    if (isErrorWhenGreater) {
      conditions = {
        combinator: 'AND',
        rules: [
          { field, operator: '<=', value: threshold }
        ]
      };
    } else if (numbers.length >= 2) {
      conditions = {
        combinator: 'AND',
        rules: [
          { field, operator: 'between', value: [Math.min(numbers[0], numbers[1]), Math.max(numbers[0], numbers[1])] }
        ]
      };
    } else {
      conditions = {
        combinator: 'AND',
        rules: [
          { field, operator: '<=', value: threshold }
        ]
      };
    }

    const wantWarning = lower.includes('figyelmeztet') || lower.includes('warning');
    const wantReview = lower.includes('felülvizsgál') || lower.includes('review') || lower.includes('ellenőrzés');

    output = {
      outputField: `${field}_ellenorzes`,
      outputType: 'classification',
      trueValue: 'Igen',
      falseValue: 'Nem',
      onTrueStatus: 'Accepted',
      onFalseStatus: wantReview ? 'Requires Review' : (wantWarning ? 'Warning' : 'Error'),
      passMessage: `A(z) ${field} értéke ({${field}}) megfelel az előírásnak (<= ${threshold}).`,
      failMessage: `A(z) ${field} értéke ({${field}}) sérti a megengedett korlátot (${threshold}).`
    };
  }

  const draftRule = {
    id: generatedId,
    name,
    description: raw,
    category,
    ruleType,
    inputFields: [],
    conditions,
    decisionTable,
    expression,
    output,
    dependencies: [],
    executionOrder: existingRules.length + 1,
    lifecycleStatus: 'Draft', // AI can NEVER set Prod directly (Section 15)
    validationStatus: 'Untested',
    version: 1
  };

  draftRule.inputFields = extractReferencedFields(draftRule);

  // Auto-detect dependencies against existing rules
  const { dependenciesOf } = buildDependencyGraph([...existingRules, draftRule]);
  draftRule.dependencies = Array.from(dependenciesOf.get(draftRule.id) || []);

  // Contradiction & overlap analysis
  const contradictions = detectRuleContradictions(draftRule, existingRules);

  // Generate suggested test cases (user must confirm expected results - Section 10)
  const suggestedTests = generateAiTestSuggestions(draftRule, existingRules);

  return {
    proposedRule: draftRule,
    aiExplanation: {
      summary: sanitizedNote,
      naturalLanguageInput: raw,
      detectedInputFields: draftRule.inputFields,
      detectedDependencies: draftRule.dependencies,
      outputField: draftRule.output.outputField,
      contradictions,
      governanceGuardrail: 'Az AI javaslat kizárólag Draft (tervezet) státuszban jön létre. Élesítés (Prod) előtt felhasználói teszteset-futtatás és emberi jóváhagyás kötelező (SC-06).'
    },
    suggestedTests
  };
}

/**
 * Checks if a proposed or edited rule contradicts or overlaps with existing rules (Section 15).
 */
function detectRuleContradictions(targetRule, existingRules = []) {
  const warnings = [];
  const targetOut = (targetRule.output && targetRule.output.outputField) || targetRule.outputField;
  const targetInputs = new Set(extractReferencedFields(targetRule));

  for (const other of existingRules) {
    if (other.id === targetRule.id || other.lifecycleStatus === 'Retired') continue;
    const otherOut = (other.output && other.output.outputField) || other.outputField;

    // 1. Duplicate outputField collision
    if (targetOut && otherOut && targetOut === otherOut) {
      warnings.push({
        type: 'OUTPUT_COLLISION',
        severity: 'Warning',
        conflictingRuleId: other.id,
        conflictingRuleName: other.name,
        message: `Kimeneti mező ütközés: A(z) '${other.id} (${other.name})' szabály már előállítja a(z) '${targetOut}' eredménymezőt.`
      });
    }

    // 2. Same single input field with potentially overlapping condition
    const otherInputs = extractReferencedFields(other);
    const sharedInputs = otherInputs.filter(f => targetInputs.has(f));
    if (sharedInputs.length > 0 && other.category === targetRule.category && targetRule.conditions && other.conditions) {
      const tRules = targetRule.conditions.rules || [];
      const oRules = other.conditions.rules || [];
      if (tRules.length === 1 && oRules.length === 1 && tRules[0].field === oRules[0].field) {
        if (tRules[0].operator === oRules[0].operator && String(tRules[0].value) !== String(oRules[0].value)) {
          warnings.push({
            type: 'THRESHOLD_OVERLAP',
            severity: 'Info',
            conflictingRuleId: other.id,
            conflictingRuleName: other.name,
            message: `Átfedő feltétel a(z) '${tRules[0].field}' mezőn a(z) '${other.id}' szabállyal (${tRules[0].operator} ${tRules[0].value} vs. ${oRules[0].operator} ${oRules[0].value}).`
          });
        }
      }
    }
  }

  return warnings;
}

/**
 * Generates AI-proposed test cases covering the 6 required categories from Specification Section 10:
 * "Az AI javasolhat normál, negatív, határérték-, hiányzóadat-, ellentmondásos és több szabályt érintő teszteket.
 *  Az elvárt eredményt a felhasználó erősíti meg."
 */
function generateAiTestSuggestions(rule, existingRules = []) {
  const ruleId = rule ? rule.id : 'PIPELINE';
  const ruleName = rule ? rule.name : 'Teljes szabálylánc';

  return [
    {
      testCode: `AI-T01`,
      category: 'Normál (Pozitív)',
      name: `${ruleId} – Normál gyártható megrendelés (Window A)`,
      description: 'Megengedett anyag (PVC), méret (1200x1400 mm) és egyező szállítási cím.',
      targetRuleId: ruleId,
      inputData: {
        rendeles_szam: 'TEST-1001',
        ugyfel_kod: 'CUST-01',
        termek: 'Window A',
        anyag: 'PVC',
        szin: 'Fehér (RAL 9016)',
        uvegezes: '2-rétegű (Ug=1.1)',
        keret_vastagsag_mm: 76,
        szelesseg_mm: 1200,
        magassag_mm: 1400,
        csomagolas: 'Kaloda',
        szallitasi_cim: '1117 Budapest, Irinyi József u. 4.',
        szerzodeses_cim: '1117 Budapest, Irinyi József u. 4.',
        kedvezmeny_pct: 5,
        egysegar_eur: 320
      },
      suggestedExpectedStatus: 'Accepted',
      userConfirmed: false
    },
    {
      testCode: `AI-T02`,
      category: 'Negatív (Szabálysértő)',
      name: `${ruleId} – Nem megengedett méret / gyárthatósági hiba (Door B)`,
      description: 'Túlzó méretű (2650 mm széles) Door B PVC profillal, amely sérti a gyárthatósági szabályt.',
      targetRuleId: ruleId,
      inputData: {
        rendeles_szam: 'TEST-1002',
        ugyfel_kod: 'CUST-02',
        termek: 'Door B',
        anyag: 'PVC',
        szin: 'Antracit (RAL 7016)',
        uvegezes: '3-rétegű (Ug=0.6)',
        keret_vastagsag_mm: 70,
        szelesseg_mm: 2650,
        magassag_mm: 2450,
        csomagolas: 'Raklap',
        szallitasi_cim: '4025 Debrecen, Piac u. 18.',
        szerzodeses_cim: '4025 Debrecen, Piac u. 18.',
        kedvezmeny_pct: 8,
        egysegar_eur: 790
      },
      suggestedExpectedStatus: 'Error',
      userConfirmed: false
    },
    {
      testCode: `AI-T03`,
      category: 'Eltérő adat (Felülvizsgálendő)',
      name: `${ruleId} – Eltérő szállítási cím (Window C)`,
      description: 'Műszakilag gyártható rendelés, de a szállítási cím eltér a szerződéses címtől.',
      targetRuleId: ruleId,
      inputData: {
        rendeles_szam: 'TEST-1003',
        ugyfel_kod: 'CUST-03',
        termek: 'Window C',
        anyag: 'Alu',
        szin: 'Ezüst eloxált',
        uvegezes: '3-rétegű (Ug=0.6)',
        keret_vastagsag_mm: 82,
        szelesseg_mm: 1500,
        magassag_mm: 1500,
        csomagolas: 'Kaloda',
        szallitasi_cim: '6720 Szeged, Tisza Lajos krt. 55. (Építési terület)',
        szerzodeses_cim: '6720 Szeged, Kárász u. 12.',
        kedvezmeny_pct: 10,
        egysegar_eur: 540
      },
      suggestedExpectedStatus: 'Requires Review',
      userConfirmed: false
    },
    {
      testCode: `AI-T04`,
      category: 'Határérték (Boundary)',
      name: `${ruleId} – Maximális szélességi határérték (2400 mm)`,
      description: 'Pontosan a felső mérethatáron (2400 mm) lévő nyílászáró.',
      targetRuleId: ruleId,
      inputData: {
        rendeles_szam: 'TEST-1004',
        ugyfel_kod: 'CUST-01',
        termek: 'Window A',
        anyag: 'Alu',
        szin: 'Fehér (RAL 9016)',
        uvegezes: '2-rétegű (Ug=1.1)',
        keret_vastagsag_mm: 82,
        szelesseg_mm: 2400,
        magassag_mm: 1600,
        csomagolas: 'Kaloda',
        szallitasi_cim: '1117 Budapest, Irinyi József u. 4.',
        szerzodeses_cim: '1117 Budapest, Irinyi József u. 4.',
        kedvezmeny_pct: 5,
        egysegar_eur: 610
      },
      suggestedExpectedStatus: 'Accepted',
      userConfirmed: false
    },
    {
      testCode: `AI-T05`,
      category: 'Hiányzó adat (Null / Missing Reference)',
      name: `${ruleId} – Hiányzó referenciaadat és üres ügyfélkód`,
      description: 'Nem létező ügyfél-referenciával és hiányzó csomagolási móddal beküldött rekord.',
      targetRuleId: ruleId,
      inputData: {
        rendeles_szam: 'TEST-1005',
        ugyfel_kod: 'ISMERETLEN-999',
        termek: 'Window A',
        anyag: 'PVC',
        szin: 'Fehér (RAL 9016)',
        uvegezes: null,
        keret_vastagsag_mm: 76,
        szelesseg_mm: 1000,
        magassag_mm: 1200,
        csomagolas: null,
        szallitasi_cim: '9021 Győr, Baross Gábor út 10.',
        szerzodeses_cim: null,
        kedvezmeny_pct: 0,
        egysegar_eur: 250
      },
      suggestedExpectedStatus: 'Error',
      userConfirmed: false
    },
    {
      testCode: `AI-T06`,
      category: 'Több szabályt érintő (Láncolt)',
      name: `${ruleId} – Láncolt méret -> felület -> súly -> csomagolás függőség`,
      description: 'Nagy felületű, 3-rétegű üvegezésű szerkezet, amely több egymásra épülő szabályt érint.',
      targetRuleId: ruleId,
      inputData: {
        rendeles_szam: 'TEST-1006',
        ugyfel_kod: 'CUST-04',
        termek: 'Window C',
        anyag: 'Alu',
        szin: 'Antracit (RAL 7016)',
        uvegezes: '3-rétegű (Ug=0.6)',
        keret_vastagsag_mm: 82,
        szelesseg_mm: 2100,
        magassag_mm: 1800,
        csomagolas: 'Fólia',
        szallitasi_cim: '7621 Pécs, Király u. 8.',
        szerzodeses_cim: '7621 Pécs, Király u. 8.',
        kedvezmeny_pct: 6,
        egysegar_eur: 890
      },
      suggestedExpectedStatus: 'Warning',
      userConfirmed: false
    }
  ];
}

module.exports = {
  synthesizeRuleFromNaturalLanguage,
  detectRuleContradictions,
  generateAiTestSuggestions
};
