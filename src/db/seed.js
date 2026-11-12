'use strict';

const { initDatabase, logAudit, saveRuleToDb } = require('./database');
const { computeDeterministicHash, executeDeterministicPipeline } = require('../engine/executionEngine');
const { extractReferencedFields } = require('../engine/ruleModel');
const { buildDependencyGraph } = require('../engine/dependencyGraph');

/**
 * Generates the 105 realistic orders for Use Case 1 (Nyílászáró-rendelésellenőrzés).
 * Records 1001, 1002, 1003 strictly match Section 5 of the Specification:
 * | Rendelés | Termék   | Gyártható | Címellenőrzés | Státusz         |
 * | 1001     | Window A | Igen      | OK            | Accepted        |
 * | 1002     | Door B   | Nem       | OK            | Error           |
 * | 1003     | Window C | Igen      | Review        | Requires Review |
 */
function buildWindowOrderRecords() {
  const baseRecords = [
    {
      rendeles_szam: '1001',
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
      iranyitoszam_zona: 'HU-CENTRAL',
      szallitasi_hatarido_nap: 14,
      kedvezmeny_pct: 5,
      egysegar_eur: 340,
      mennyiseg_db: 2
    },
    {
      rendeles_szam: '1002',
      ugyfel_kod: 'CUST-02',
      termek: 'Door B',
      anyag: 'PVC',
      szin: 'Antracit (RAL 7016)',
      uvegezes: '3-rétegű (Ug=0.6)',
      keret_vastagsag_mm: 76,
      szelesseg_mm: 2650,
      magassag_mm: 2450,
      csomagolas: 'Kaloda',
      szallitasi_cim: '4025 Debrecen, Piac u. 18.',
      iranyitoszam_zona: 'HU-EAST',
      szallitasi_hatarido_nap: 18,
      kedvezmeny_pct: 6,
      egysegar_eur: 890,
      mennyiseg_db: 1
    },
    {
      rendeles_szam: '1003',
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
      iranyitoszam_zona: 'HU-SOUTH',
      szallitasi_hatarido_nap: 15,
      kedvezmeny_pct: 8,
      egysegar_eur: 560,
      mennyiseg_db: 3
    }
  ];

  const customerConfigs = [
    { code: 'CUST-01', addr: '1117 Budapest, Irinyi József u. 4.', zone: 'HU-CENTRAL' },
    { code: 'CUST-02', addr: '4025 Debrecen, Piac u. 18.', zone: 'HU-EAST' },
    { code: 'CUST-03', addr: '6720 Szeged, Kárász u. 12.', zone: 'HU-SOUTH' },
    { code: 'CUST-04', addr: '9021 Győr, Baross Gábor út 10.', zone: 'HU-WEST' },
    { code: 'CUST-05', addr: '7621 Pécs, Király u. 8.', zone: 'HU-SOUTH' },
    { code: 'CUST-06', addr: '3525 Miskolc, Széchenyi István út 22.', zone: 'HU-NORTH' }
  ];

  const products = ['Window A', 'Window C', 'Door B', 'Sliding Patio D', 'Roof Window E'];
  const materials = ['PVC', 'Alu', 'Fa'];
  const colors = ['Fehér (RAL 9016)', 'Antracit (RAL 7016)', 'Aranytölgy', 'Ezüst eloxált', 'Dió barna'];

  for (let i = 4; i <= 105; i++) {
    const orderNo = String(1000 + i);
    const cust = customerConfigs[i % customerConfigs.length];
    let termek = products[i % products.length];
    let anyag = materials[i % materials.length];
    let szin = colors[i % colors.length];
    let uvegezes = (i % 3 === 0) ? '3-rétegű (Ug=0.6)' : '2-rétegű (Ug=1.1)';
    let keret = uvegezes.startsWith('3') ? 82 : 76;
    let szelesseg = 900 + ((i * 37) % 1100);
    let magassag = 1000 + ((i * 29) % 1000);
    let csomagolas = 'Kaloda';
    let szallitasi_cim = cust.addr;
    let hatarido = 14 + (i % 7);
    let kedvezmeny = 4 + (i % 8);
    let egysegar = 320 + ((i * 19) % 450);
    let mennyiseg = 1 + (i % 4);
    let technikai_hiba_teszt = null;

    // Make Door B and Sliding Patio D valid in normal rows
    if (termek === 'Door B') {
      anyag = 'Alu';
      szelesseg = 1000;
      magassag = 2100;
    } else if (termek === 'Sliding Patio D') {
      anyag = 'Alu';
      keret = 82;
      szelesseg = 2000;
      magassag = 2100;
    }

    // Introduce specific deterministic business & technical scenarios across the 105 records:
    if (i === 8 || i === 24 || i === 52 || i === 78) {
      // Oversized non-manufacturable -> Error
      termek = 'Door B';
      anyag = 'PVC';
      szelesseg = 2580;
      magassag = 2420;
    } else if (i === 12 || i === 38 || i === 66) {
      // Thin frame (60mm) with triple glazing -> Error
      uvegezes = '3-rétegű (Ug=0.6)';
      keret = 60;
    } else if (i === 15 || i === 31 || i === 49 || i === 73 || i === 91) {
      // Shipping address differs from contract address -> Requires Review
      szallitasi_cim = `${cust.addr} – 2. sz. Ideiglenes Lerakó`;
    } else if (i === 19 || i === 44 || i === 85) {
      // Excessive discount (> 15%) -> Requires Review
      kedvezmeny = 19;
    } else if (i === 22 || i === 35 || i === 61 || i === 88) {
      // Foil packaging instead of Kaloda/Raklap on multi-unit glazing -> Warning
      csomagolas = 'Fólia';
    } else if (i === 28 || i === 69) {
      // Short delivery lead time (5 days < 7 days standard) -> Warning
      hatarido = 5;
    } else if (i === 99) {
      // Record 1099: Explicit technical execution error demonstration (Specification Section 11 & 12)
      technikai_hiba_teszt = 'R-011';
    }

    const rec = {
      rendeles_szam: orderNo,
      ugyfel_kod: cust.code,
      termek,
      anyag,
      szin,
      uvegezes,
      keret_vastagsag_mm: keret,
      szelesseg_mm: szelesseg,
      magassag_mm: magassag,
      csomagolas,
      szallitasi_cim,
      iranyitoszam_zona: cust.zone,
      szallitasi_hatarido_nap: hatarido,
      kedvezmeny_pct: kedvezmeny,
      egysegar_eur: egysegar,
      mennyiseg_db: mennyiseg
    };
    if (technikai_hiba_teszt) {
      rec.technikai_hiba_teszt = technikai_hiba_teszt;
    }
    baseRecords.push(rec);
  }

  return baseRecords;
}

/**
 * Generates 85 realistic, interdependent rules (R-001 through R-085) across 8 functional layers
 * to satisfy SC-02 ("Legalább 80 részben egymástól függő szabály kezelhető") and Section 9.
 * - R-001 .. R-080: Prod (80 active production rules)
 * - R-081 .. R-082: Test (2 rules in Test lifecycle)
 * - R-083 .. R-084: Draft (2 rules in Draft lifecycle)
 * - R-085: Retired (1 retired historical rule)
 */
function buildWindowValidationRules() {
  const rules = [];

  const addRule = (cfg) => {
    const order = rules.length + 1;
    const ruleObj = {
      id: cfg.id || `R-${String(order).padStart(3, '0')}`,
      name: cfg.name,
      description: cfg.description || cfg.name,
      category: cfg.category,
      ruleType: cfg.ruleType || 'visual_condition',
      inputFields: cfg.inputFields || [],
      conditions: cfg.conditions || null,
      decisionTable: cfg.decisionTable || null,
      expression: cfg.expression || null,
      output: cfg.output,
      dependencies: cfg.dependencies || [],
      executionOrder: order,
      lifecycleStatus: cfg.lifecycleStatus || 'Prod',
      validationStatus: cfg.validationStatus || (cfg.lifecycleStatus === 'Draft' ? 'Untested' : 'Passed'),
      version: cfg.version || 1,
      approvedBy: (cfg.lifecycleStatus || 'Prod') === 'Prod' ? 'Kovács Anna (Üzleti Szabálygazda)' : null,
      approvedAt: (cfg.lifecycleStatus || 'Prod') === 'Prod' ? '2026-11-10T09:00:00.000Z' : null,
      approvalNote: (cfg.lifecycleStatus || 'Prod') === 'Prod' ? 'Tesztesetek alapján jóváhagyva és élesítve.' : null,
      updatedAt: '2026-11-10T09:00:00.000Z'
    };
    ruleObj.inputFields = extractReferencedFields(ruleObj);
    rules.push(ruleObj);
  };

  // =========================================================================
  // LAYER 1: Adatminőség és Referencia Ellenőrzések (R-001 .. R-010)
  // =========================================================================
  addRule({
    id: 'R-001',
    name: 'Rendelésszám kötelező megléte',
    category: '1. Adatminőség és Referenciák',
    description: 'Ellenőrzi, hogy a rendelésszám (rendeles_szam) ki van-e töltve.',
    conditions: { combinator: 'AND', rules: [{ field: 'rendeles_szam', operator: 'is_not_null' }] },
    output: {
      outputField: 'rendeles_szam_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Rendelésszám kitöltve ({rendeles_szam}).',
      failMessage: 'Hiányzó rendelésszám!'
    }
  });

  addRule({
    id: 'R-002',
    name: 'Ügyfél-referencia létezése a törzsadatban',
    category: '1. Adatminőség és Referenciák',
    description: 'Ellenőrzi, hogy az ügyfélkódhoz tartozik-e érvényes szerződéses törzsrekord.',
    conditions: { combinator: 'AND', rules: [{ field: 'szerzodeses_cim', operator: 'is_not_null' }] },
    output: {
      outputField: 'ugyfel_referencia_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Ügyfél-referencia ({ugyfel_kod}) megtalálható a törzsben.',
      failMessage: 'Hiányzó referenciaadat: az ügyfélkód ({ugyfel_kod}) nem szerepel a szerződéses törzsben!'
    }
  });

  addRule({
    id: 'R-003',
    name: 'Terméktípus katalógus-azonosítás',
    category: '1. Adatminőség és Referenciák',
    description: 'A megadott terméktípus szerepel az engedélyezett gyári termékkatalógusban.',
    conditions: {
      combinator: 'AND',
      rules: [{ field: 'termek', operator: 'in', value: ['Window A', 'Window C', 'Door B', 'Sliding Patio D', 'Roof Window E'] }]
    },
    output: {
      outputField: 'termek_katalogus_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Érvényes terméktípus ({termek}).',
      failMessage: 'Ismeretlen terméktípus ({termek}).'
    }
  });

  addRule({
    id: 'R-004',
    name: 'Anyagkód érvényesség ellenőrzése',
    category: '1. Adatminőség és Referenciák',
    description: 'Az alapanyag csak PVC, Alu vagy Fa lehet.',
    conditions: {
      combinator: 'AND',
      rules: [{ field: 'anyag', operator: 'in', value: ['PVC', 'Alu', 'Fa'] }]
    },
    output: {
      outputField: 'anyag_kod_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Érvényes alapanyag ({anyag}).',
      failMessage: 'Nem támogatott alapanyag ({anyag}).'
    }
  });

  addRule({
    id: 'R-005',
    name: 'Üvegezés specifikáció megléte',
    category: '1. Adatminőség és Referenciák',
    description: 'Az üvegezés mező nem lehet üres.',
    conditions: { combinator: 'AND', rules: [{ field: 'uvegezes', operator: 'is_not_null' }] },
    output: {
      outputField: 'uvegezes_megadva',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Üvegezés megadva ({uvegezes}).',
      failMessage: 'Hiányzó üvegezés specifikáció!'
    }
  });

  addRule({
    id: 'R-006',
    name: 'Pozitív geometriai méretek megléte',
    category: '1. Adatminőség és Referenciák',
    description: 'A szélesség és magasság értékének pozitív számnak (> 200 mm) kell lennie.',
    conditions: {
      combinator: 'AND',
      rules: [
        { field: 'szelesseg_mm', operator: '>', value: 200 },
        { field: 'magassag_mm', operator: '>', value: 200 }
      ]
    },
    output: {
      outputField: 'alap_meret_pozitiv',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Alapméretek pozitív tartományban ({szelesseg_mm}x{magassag_mm} mm).',
      failMessage: 'Érvénytelen alapméret ({szelesseg_mm}x{magassag_mm} mm).'
    }
  });

  addRule({
    id: 'R-007',
    name: 'Keretvastagság megadása (mm)',
    category: '1. Adatminőség és Referenciák',
    description: 'A keret profilvastagsága minimum 50 mm kell legyen.',
    conditions: { combinator: 'AND', rules: [{ field: 'keret_vastagsag_mm', operator: '>=', value: 50 }] },
    output: {
      outputField: 'keret_adat_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Keretvastagság érvényes ({keret_vastagsag_mm} mm).',
      failMessage: 'Érvénytelen keretvastagság ({keret_vastagsag_mm} mm).'
    }
  });

  addRule({
    id: 'R-008',
    name: 'Csomagolási mód megadása',
    category: '1. Adatminőség és Referenciák',
    description: 'A csomagolási mód mező kötelező.',
    conditions: { combinator: 'AND', rules: [{ field: 'csomagolas', operator: 'is_not_null' }] },
    output: {
      outputField: 'csomagolas_megadva',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Csomagolási mód rögzítve ({csomagolas}).',
      failMessage: 'Hiányzó csomagolási mód!'
    }
  });

  addRule({
    id: 'R-009',
    name: 'Szállítási cím kitöltöttsége',
    category: '1. Adatminőség és Referenciák',
    description: 'A szállítási cím nem lehet üres.',
    conditions: { combinator: 'AND', rules: [{ field: 'szallitasi_cim', operator: 'is_not_null' }] },
    output: {
      outputField: 'szallitasi_cim_megadva',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Szállítási cím megadva.',
      failMessage: 'Hiányzó szállítási cím!'
    }
  });

  addRule({
    id: 'R-010',
    name: 'Összesített alapadat-teljesség (Layer 1 szintézis)',
    category: '1. Adatminőség és Referenciák',
    description: 'Összesíti az R-001..R-009 szabályok eredményét.',
    conditions: {
      combinator: 'AND',
      rules: [
        { field: 'rendeles_szam_ok', operator: '==', value: true },
        { field: 'ugyfel_referencia_ok', operator: '==', value: true },
        { field: 'termek_katalogus_ok', operator: '==', value: true },
        { field: 'anyag_kod_ok', operator: '==', value: true },
        { field: 'uvegezes_megadva', operator: '==', value: true },
        { field: 'alap_meret_pozitiv', operator: '==', value: true },
        { field: 'keret_adat_ok', operator: '==', value: true },
        { field: 'csomagolas_megadva', operator: '==', value: true },
        { field: 'szallitasi_cim_megadva', operator: '==', value: true }
      ]
    },
    output: {
      outputField: 'adat_teljes',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Minden kötelező alapadat és referencia hiánytalan.',
      failMessage: 'Hiányos alapadat vagy hiányzó referenciaadat!'
    }
  });

  // =========================================================================
  // LAYER 2: Geometria és Méretszámítások (R-011 .. R-022) – depends on Layer 1
  // =========================================================================
  addRule({
    id: 'R-011',
    name: 'Nyílászáró felület számítása (m²)',
    category: '2. Geometria és Méretszámítások',
    description: 'Kiszámítja az elem felületét négyzetméterben a szélesség és magasság alapján.',
    ruleType: 'expression',
    dependencies: ['R-006', 'R-010'],
    expression: 'ROUND((szelesseg_mm * magassag_mm) / 1000000, 2)',
    output: {
      outputField: 'felulet_m2',
      outputType: 'calculated',
      expression: 'ROUND((szelesseg_mm * magassag_mm) / 1000000, 2)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Számított felület: {OUT} m².'
    }
  });

  addRule({
    id: 'R-012',
    name: 'Kerület számítása (folyóméter)',
    category: '2. Geometria és Méretszámítások',
    description: 'Kiszámítja a tok- és tömítéskerületet méterben.',
    ruleType: 'expression',
    dependencies: ['R-006'],
    expression: 'ROUND(2 * (szelesseg_mm + magassag_mm) / 1000, 2)',
    output: {
      outputField: 'kerulet_m',
      outputType: 'calculated',
      expression: 'ROUND(2 * (szelesseg_mm + magassag_mm) / 1000, 2)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Számított kerület: {OUT} m.'
    }
  });

  addRule({
    id: 'R-013',
    name: 'Oldalarány (szélesség / magasság) számítása',
    category: '2. Geometria és Méretszámítások',
    description: 'Számítja a nyílászáró oldalarányát a vasalatterheléshez.',
    ruleType: 'expression',
    dependencies: ['R-006'],
    expression: 'ROUND(szelesseg_mm / magassag_mm, 2)',
    output: {
      outputField: 'oldalarany',
      outputType: 'calculated',
      expression: 'ROUND(szelesseg_mm / magassag_mm, 2)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Oldalarány: {OUT}.'
    }
  });

  addRule({
    id: 'R-014',
    name: 'Oldalarány stabilitási tartomány (0.25 .. 3.50)',
    category: '2. Geometria és Méretszámítások',
    description: 'Az oldalarány nem lehet szélsőségesen keskeny vagy lapos.',
    dependencies: ['R-013'],
    conditions: { combinator: 'AND', rules: [{ field: 'oldalarany', operator: 'between', value: [0.25, 3.5] }] },
    output: {
      outputField: 'oldalarany_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Oldalarány ({oldalarany}) stabil.',
      failMessage: 'Szélsőséges oldalarány ({oldalarany}) – nem gyártható!'
    }
  });

  addRule({
    id: 'R-015',
    name: 'Minimális gyártható szélesség (>= 400 mm)',
    category: '2. Geometria és Méretszámítások',
    description: 'A CNC hegesztő- és tisztítógép minimális szélességi korlátja 400 mm.',
    dependencies: ['R-006'],
    conditions: { combinator: 'AND', rules: [{ field: 'szelesseg_mm', operator: '>=', value: 400 }] },
    output: {
      outputField: 'min_szelesseg_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Minimális szélesség teljesül ({szelesseg_mm} mm >= 400 mm).',
      failMessage: 'A szélesség ({szelesseg_mm} mm) kisebb a 400 mm-es minimumkorlátnál!'
    }
  });

  addRule({
    id: 'R-016',
    name: 'Minimális gyártható magasság (>= 400 mm)',
    category: '2. Geometria és Méretszámítások',
    description: 'A CNC gyártósor minimális magassági korlátja 400 mm.',
    dependencies: ['R-006'],
    conditions: { combinator: 'AND', rules: [{ field: 'magassag_mm', operator: '>=', value: 400 }] },
    output: {
      outputField: 'min_magassag_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Minimális magasság teljesül ({magassag_mm} mm >= 400 mm).',
      failMessage: 'A magasság ({magassag_mm} mm) kisebb a 400 mm-es minimumkorlátnál!'
    }
  });

  addRule({
    id: 'R-017',
    name: 'Maximális abszolút szélességi korlát (<= 2400 mm)',
    category: '2. Geometria és Méretszámítások',
    description: 'Az egyelemű szerkezet szélessége nem haladhatja meg a 2400 mm-t.',
    dependencies: ['R-006'],
    conditions: { combinator: 'AND', rules: [{ field: 'szelesseg_mm', operator: '<=', value: 2400 }] },
    output: {
      outputField: 'max_szelesseg_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Szélesség ({szelesseg_mm} mm) a 2400 mm-es felső határon belül.',
      failMessage: 'Nem megengedett méret: a szélesség ({szelesseg_mm} mm) meghaladja a 2400 mm-es gyárthatósági határt!'
    }
  });

  addRule({
    id: 'R-018',
    name: 'Maximális abszolút magassági korlát (<= 2400 mm)',
    category: '2. Geometria és Méretszámítások',
    description: 'Az egyelemű szerkezet magassága nem haladhatja meg a 2400 mm-t.',
    dependencies: ['R-006'],
    conditions: { combinator: 'AND', rules: [{ field: 'magassag_mm', operator: '<=', value: 2400 }] },
    output: {
      outputField: 'max_magassag_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Magasság ({magassag_mm} mm) a 2400 mm-es felső határon belül.',
      failMessage: 'Nem megengedett méret: a magasság ({magassag_mm} mm) meghaladja a 2400 mm-es gyárthatósági határt!'
    }
  });

  addRule({
    id: 'R-019',
    name: 'Maximális elemfelület korlát (<= 5.0 m²)',
    category: '2. Geometria és Méretszámítások',
    description: 'Egyetlen nyílászáró elem felülete nem haladhatja meg az 5.0 m²-t.',
    dependencies: ['R-011'],
    conditions: { combinator: 'AND', rules: [{ field: 'felulet_m2', operator: '<=', value: 5.0 }] },
    output: {
      outputField: 'max_felulet_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Elemfelület ({felulet_m2} m²) megengedett.',
      failMessage: 'Az elemfelület ({felulet_m2} m²) meghaladja az 5.0 m²-es statikai korlátot!'
    }
  });

  addRule({
    id: 'R-020',
    name: 'Katalógus szerinti termék-specifikus szélesség ellenőrzés (SQL forrásból)',
    category: '2. Geometria és Méretszámítások',
    description: 'Összeveti a rendelés szélességét az SQL katalógusban tárolt max_width_mm értékkel.',
    dependencies: ['R-003', 'R-017'],
    conditions: {
      combinator: 'OR',
      rules: [
        { field: 'sql_max_width_mm', operator: 'is_null' },
        { field: 'szelesseg_mm', operator: 'lte_field', valueFromField: 'sql_max_width_mm', value: 'sql_max_width_mm' }
      ]
    },
    output: {
      outputField: 'sql_szelesseg_limit_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Szélesség megfelel az SQL gyári katalógusnak.',
      failMessage: 'A szélesség ({szelesseg_mm} mm) meghaladja a(z) {termek} SQL katalógus korlátját ({sql_max_width_mm} mm)!'
    }
  });

  addRule({
    id: 'R-021',
    name: 'Becsült szárnysúly számítása (kg)',
    category: '2. Geometria és Méretszámítások',
    description: 'Kiszámítja az egyedi elem súlyát a felületből (32 kg/m² átlagos szerkezeti súly).',
    ruleType: 'expression',
    dependencies: ['R-011'],
    expression: 'ROUND(felulet_m2 * 32, 1)',
    output: {
      outputField: 'elem_suly_kg',
      outputType: 'calculated',
      expression: 'ROUND(felulet_m2 * 32, 1)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Becsült elemsúly: {OUT} kg.'
    }
  });

  addRule({
    id: 'R-022',
    name: 'Összesített geometriai megfelelőség (Layer 2 szintézis)',
    category: '2. Geometria és Méretszámítások',
    description: 'Összesíti a geometriai és méretkorlát szabályok eredményét.',
    dependencies: ['R-014', 'R-015', 'R-016', 'R-017', 'R-018', 'R-019', 'R-020'],
    conditions: {
      combinator: 'AND',
      rules: [
        { field: 'oldalarany_ok', operator: '==', value: true },
        { field: 'min_szelesseg_ok', operator: '==', value: true },
        { field: 'min_magassag_ok', operator: '==', value: true },
        { field: 'max_szelesseg_ok', operator: '==', value: true },
        { field: 'max_magassag_ok', operator: '==', value: true },
        { field: 'max_felulet_ok', operator: '==', value: true },
        { field: 'sql_szelesseg_limit_ok', operator: '==', value: true }
      ]
    },
    output: {
      outputField: 'geometria_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Minden geometriai és méretkorlát teljesül.',
      failMessage: 'Geometriai vagy méretkorlát hiba miatt a tétel nem gyártható!'
    }
  });

  // =========================================================================
  // LAYER 3: Anyag, Profil és Szerkezeti Kompatibilitás (R-023 .. R-035)
  // =========================================================================
  addRule({
    id: 'R-023',
    name: 'Termék × Anyag × Méret Kompatibilitási Döntési Tábla',
    category: '3. Anyag és Szerkezeti Kompatibilitás',
    description: 'Döntési tábla a terméktípus, alapanyag és szélesség együttes gyárthatóságáról.',
    ruleType: 'decision_table',
    dependencies: ['R-003', 'R-004', 'R-011'],
    decisionTable: {
      hitPolicy: 'FIRST',
      inputs: [
        { field: 'termek', label: 'Terméktípus' },
        { field: 'anyag', label: 'Alapanyag' },
        { field: 'szelesseg_mm', label: 'Szélesség (mm)' }
      ],
      rows: [
        {
          conditions: { termek: 'Door B', anyag: 'PVC', szelesseg_mm: '> 1400' },
          outputValue: false,
          statusEffect: 'Error',
          reason: 'Door B bejárati ajtó PVC anyagból 1400 mm szélesség felett statikailag nem gyártható!'
        },
        {
          conditions: { termek: 'Sliding Patio D', anyag: 'PVC', szelesseg_mm: '> 2200' },
          outputValue: false,
          statusEffect: 'Error',
          reason: 'Tolóajtó (Sliding Patio D) 2200 mm felett kizárólag Alu profillal gyártható.'
        },
        {
          conditions: { termek: '*', anyag: '*', szelesseg_mm: '[400..2400]' },
          outputValue: true,
          statusEffect: 'Accepted',
          reason: 'Megengedett termék-anyag-méret kombináció.'
        }
      ],
      defaultOutcome: {
        outputValue: false,
        statusEffect: 'Error',
        reason: 'Nem engedélyezett termék-anyag-méret kombináció.'
      }
    },
    output: {
      outputField: 'kombinacio_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Termék-anyag-méret döntési tábla megfelelt.',
      failMessage: 'Nem megengedett termék-anyag-méret kombináció!'
    }
  });

  addRule({
    id: 'R-024',
    name: 'PVC profil maximális felületi terhelhetősége (<= 3.6 m²)',
    category: '3. Anyag és Szerkezeti Kompatibilitás',
    description: 'PVC alapanyag esetén az elemfelület nem haladhatja meg a 3.6 m²-t.',
    dependencies: ['R-011'],
    conditions: {
      combinator: 'OR',
      rules: [
        { field: 'anyag', operator: '!=', value: 'PVC' },
        { field: 'felulet_m2', operator: '<=', value: 3.6 }
      ]
    },
    output: {
      outputField: 'pvc_felulet_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'PVC felületi korlát rendben.',
      failMessage: 'PVC profilnál a(z) {felulet_m2} m² felület meghaladja a 3.6 m²-es határt!'
    }
  });

  addRule({
    id: 'R-025',
    name: 'Acélmerevítés szükségességének megállapítása',
    category: '3. Anyag és Szerkezeti Kompatibilitás',
    description: 'PVC profilnál 1.5 m² felület felett emelt vastagságú (2.0 mm) acélmerevítés szükséges.',
    ruleType: 'expression',
    dependencies: ['R-011'],
    expression: 'IF(anyag == "PVC" AND felulet_m2 >= 1.5, "2.0mm_emelt_acel", "standard")',
    output: {
      outputField: 'merevites_tipus',
      outputType: 'calculated',
      expression: 'IF(anyag == "PVC" AND felulet_m2 >= 1.5, "2.0mm_emelt_acel", "standard")',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Merevítés típusa: {OUT}.'
    }
  });

  addRule({
    id: 'R-026',
    name: 'Sötét színfólia (Antracit) hőtágulási profilvastagság szabály',
    category: '3. Anyag és Szerkezeti Kompatibilitás',
    description: 'PVC Antracit szín esetén a keretvastagságnak legalább 70 mm-nek kell lennie.',
    dependencies: ['R-007'],
    conditions: {
      combinator: 'OR',
      rules: [
        { field: 'anyag', operator: '!=', value: 'PVC' },
        { field: 'szin', operator: 'not_contains', value: 'Antracit' },
        { field: 'keret_vastagsag_mm', operator: '>=', value: 70 }
      ]
    },
    output: {
      outputField: 'szin_hotagulas_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Szín hőtágulási profil-előírás teljesül.',
      failMessage: 'Antracit PVC profilhoz minimum 70 mm keretvastagság szükséges!'
    }
  });

  addRule({
    id: 'R-027',
    name: 'Bejárati ajtó (Door B) zsanérterhelési határ (<= 120 kg)',
    category: '3. Anyag és Szerkezeti Kompatibilitás',
    description: 'Door B esetén az elemsúly nem haladhatja meg a 120 kg-ot.',
    dependencies: ['R-021'],
    conditions: {
      combinator: 'OR',
      rules: [
        { field: 'termek', operator: '!=', value: 'Door B' },
        { field: 'elem_suly_kg', operator: '<=', value: 120 }
      ]
    },
    output: {
      outputField: 'ajto_zsaner_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Ajtó zsanérterhelés ({elem_suly_kg} kg) határértéken belül.',
      failMessage: 'A Door B számított súlya ({elem_suly_kg} kg) meghaladja a 120 kg-os zsanérterhelési határt!'
    }
  });

  addRule({
    id: 'R-028',
    name: 'Tolóajtó (Sliding Patio D) keretvastagság minimum (>= 76 mm)',
    category: '3. Anyag és Szerkezeti Kompatibilitás',
    description: 'Sliding Patio D típushoz minimum 76 mm-es keretvastagság szükséges.',
    dependencies: ['R-007'],
    conditions: {
      combinator: 'OR',
      rules: [
        { field: 'termek', operator: '!=', value: 'Sliding Patio D' },
        { field: 'keret_vastagsag_mm', operator: '>=', value: 76 }
      ]
    },
    output: {
      outputField: 'toloajto_keret_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Tolóajtó keretvastagság megfelelő.',
      failMessage: 'Sliding Patio D típushoz minimum 76 mm keretvastagság kötelező!'
    }
  });

  addRule({
    id: 'R-029',
    name: 'Tetőablak (Roof Window E) maximális méretkorlát',
    category: '3. Anyag és Szerkezeti Kompatibilitás',
    description: 'Tetőablak esetén a szélesség legfeljebb 1600 mm lehet.',
    dependencies: ['R-006'],
    conditions: {
      combinator: 'OR',
      rules: [
        { field: 'termek', operator: '!=', value: 'Roof Window E' },
        { field: 'szelesseg_mm', operator: '<=', value: 1600 }
      ]
    },
    output: {
      outputField: 'tetoablak_meret_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Tetőablak mérethatár rendben.',
      failMessage: 'Tetőablak (Roof Window E) szélessége nem haladhatja meg az 1600 mm-t!'
    }
  });

  addRule({
    id: 'R-030',
    name: 'Fa nyílászáró felületkezelési kompatibilitás',
    category: '3. Anyag és Szerkezeti Kompatibilitás',
    description: 'Fa alapanyag nem kombinálható fémes "eloxált" felülettel.',
    dependencies: ['R-004'],
    conditions: {
      combinator: 'OR',
      rules: [
        { field: 'anyag', operator: '!=', value: 'Fa' },
        { field: 'szin', operator: 'not_contains', value: 'eloxált' }
      ]
    },
    output: {
      outputField: 'fa_szin_kompatibilis',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Alapanyag és színkezelés kompatibilis.',
      failMessage: 'Fa alapanyag nem rendelhető eloxált fém felületkezeléssel!'
    }
  });

  addRule({
    id: 'R-031',
    name: 'Vasalat terhelési osztály meghatározása',
    category: '3. Anyag és Szerkezeti Kompatibilitás',
    description: 'Az elemsúly alapján besorolja a vasalatot (Standard <= 80kg, HeavyDuty > 80kg).',
    ruleType: 'expression',
    dependencies: ['R-021'],
    expression: 'IF(elem_suly_kg > 80, "HeavyDuty_130kg", "Standard_80kg")',
    output: {
      outputField: 'vasalat_osztaly',
      outputType: 'calculated',
      expression: 'IF(elem_suly_kg > 80, "HeavyDuty_130kg", "Standard_80kg")',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Vasalat osztály: {OUT}.'
    }
  });

  addRule({
    id: 'R-032',
    name: 'Tömítési profilhossz számítása (m)',
    category: '3. Anyag és Szerkezeti Kompatibilitás',
    description: 'Kétszeres gumitömítési hossz a kerület alapján.',
    ruleType: 'expression',
    dependencies: ['R-012'],
    expression: 'ROUND(kerulet_m * 2, 2)',
    output: {
      outputField: 'tomites_hossz_m',
      outputType: 'calculated',
      expression: 'ROUND(kerulet_m * 2, 2)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Tömítési hossz: {OUT} m.'
    }
  });

  addRule({
    id: 'R-033',
    name: 'Alumínium hőhídmentes profil ellenőrzés',
    category: '3. Anyag és Szerkezeti Kompatibilitás',
    description: 'Alu profilnál a keretvastagság minimum 65 mm kell legyen.',
    dependencies: ['R-004', 'R-007'],
    conditions: {
      combinator: 'OR',
      rules: [
        { field: 'anyag', operator: '!=', value: 'Alu' },
        { field: 'keret_vastagsag_mm', operator: '>=', value: 65 }
      ]
    },
    output: {
      outputField: 'alu_profil_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Alumínium profilvastagság megfelelő.',
      failMessage: 'Alumínium szerkezethez minimum 65 mm-es hőhídmentes profil szükséges!'
    }
  });

  addRule({
    id: 'R-034',
    name: ' Küszöbprofil típus meghatározása',
    category: '3. Anyag és Szerkezeti Kompatibilitás',
    description: 'Ajtóknál akadálymentes alumínium küszöb, ablakoknál könyöklő csatlakozó.',
    ruleType: 'expression',
    dependencies: ['R-003'],
    expression: 'IF(termek == "Door B" OR termek == "Sliding Patio D", "Alu_Akadalymentes_20mm", "Ablak_Parapet_Profil")',
    output: {
      outputField: 'kuszob_profil',
      outputType: 'calculated',
      expression: 'IF(termek == "Door B" OR termek == "Sliding Patio D", "Alu_Akadalymentes_20mm", "Ablak_Parapet_Profil")',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Küszöbprofil: {OUT}.'
    }
  });

  addRule({
    id: 'R-035',
    name: 'Összesített szerkezeti kompatibilitás (Layer 3 szintézis)',
    category: '3. Anyag és Szerkezeti Kompatibilitás',
    description: 'Összesíti az anyag-, profil- és szerkezeti szabályokat.',
    dependencies: ['R-023', 'R-024', 'R-026', 'R-027', 'R-028', 'R-029', 'R-030', 'R-033'],
    conditions: {
      combinator: 'AND',
      rules: [
        { field: 'kombinacio_ok', operator: '==', value: true },
        { field: 'pvc_felulet_ok', operator: '==', value: true },
        { field: 'szin_hotagulas_ok', operator: '==', value: true },
        { field: 'ajto_zsaner_ok', operator: '==', value: true },
        { field: 'toloajto_keret_ok', operator: '==', value: true },
        { field: 'tetoablak_meret_ok', operator: '==', value: true },
        { field: 'fa_szin_kompatibilis', operator: '==', value: true },
        { field: 'alu_profil_ok', operator: '==', value: true }
      ]
    },
    output: {
      outputField: 'szerkezet_kompatibilis',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Szerkezeti és anyagkompatibilitás teljesül.',
      failMessage: 'Szerkezeti vagy anyagkompatibilitási hiba!'
    }
  });

  // =========================================================================
  // LAYER 4: Üvegezés és Hőtechnika (R-036 .. R-047)
  // =========================================================================
  addRule({
    id: 'R-036',
    name: '3-rétegű üvegezés minimális keretvastagság igénye (>= 70 mm)',
    category: '4. Üvegezés és Hőtechnika',
    description: '3-rétegű (44 mm-es) hőszigetelő üvegcsomag nem építhető be 70 mm-nél keskenyebb profilba.',
    dependencies: ['R-005', 'R-007'],
    conditions: {
      combinator: 'OR',
      rules: [
        { field: 'uvegezes', operator: 'not_contains', value: '3-rétegű' },
        { field: 'keret_vastagsag_mm', operator: '>=', value: 70 }
      ]
    },
    output: {
      outputField: 'uveg_keret_kompatibilis',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Az üvegezés és keretvastagság ({keret_vastagsag_mm} mm) kompatibilis.',
      failMessage: '3-rétegű üvegezés nem építhető be {keret_vastagsag_mm} mm-es keretbe (min. 70 mm szükséges)!'
    }
  });

  addRule({
    id: 'R-037',
    name: 'Biztonsági edzett/ragasztott (ESG/VSG) üveg előírás nagy felületnél',
    category: '4. Üvegezés és Hőtechnika',
    description: 'Ajtóknál vagy 2.2 m² feletti felületnél biztonsági üvegréteg alkalmazandó.',
    ruleType: 'expression',
    dependencies: ['R-011'],
    expression: 'IF(termek == "Door B" OR termek == "Sliding Patio D" OR felulet_m2 > 2.2, "ESG_VSG_Biztonsagi", "Standard_Float")',
    output: {
      outputField: 'uveg_biztonsagi_osztaly',
      outputType: 'calculated',
      expression: 'IF(termek == "Door B" OR termek == "Sliding Patio D" OR felulet_m2 > 2.2, "ESG_VSG_Biztonsagi", "Standard_Float")',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Üveg biztonsági osztály: {OUT}.'
    }
  });

  addRule({
    id: 'R-038',
    name: 'Becsült Uw hőátbocsátási tényező (W/m²K)',
    category: '4. Üvegezés és Hőtechnika',
    description: 'Kiszámítja a nyílászáró teljes Uw értékét az üvegezés és keretvastagság alapján.',
    ruleType: 'expression',
    dependencies: ['R-005', 'R-007'],
    expression: 'IF(keret_vastagsag_mm >= 80, 0.78, IF(keret_vastagsag_mm >= 76, 0.92, 1.15))',
    output: {
      outputField: 'uw_ertek',
      outputType: 'calculated',
      expression: 'IF(keret_vastagsag_mm >= 80, 0.78, IF(keret_vastagsag_mm >= 76, 0.92, 1.15))',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Számított Uw hőátbocsátás: {OUT} W/m²K.'
    }
  });

  addRule({
    id: 'R-039',
    name: 'Energetikai megfelelőség (Uw <= 1.20 W/m²K)',
    category: '4. Üvegezés és Hőtechnika',
    description: 'Az építési energetikai szabvány szerint az Uw nem haladhatja meg az 1.20 W/m²K értéket.',
    dependencies: ['R-038'],
    conditions: { combinator: 'AND', rules: [{ field: 'uw_ertek', operator: '<=', value: 1.20 }] },
    output: {
      outputField: 'energetika_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Uw érték ({uw_ertek} W/m²K) megfelel az energetikai előírásnak.',
      failMessage: 'Uw érték ({uw_ertek} W/m²K) nem felel meg az energetikai előírásnak!'
    }
  });

  addRule({
    id: 'R-040',
    name: 'Melegperemes távtartó (Warm-Edge) besorolás',
    category: '4. Üvegezés és Hőtechnika',
    description: '3-rétegű üvegezéshez automatikusan Swisspacer Ultimate melegperem jár.',
    ruleType: 'expression',
    dependencies: ['R-005'],
    expression: 'IF(uvegezes == "3-rétegű (Ug=0.6)", "Swisspacer_WarmEdge", "Alu_Standard_Spacer")',
    output: {
      outputField: 'tavtarto_tipus',
      outputType: 'calculated',
      expression: 'IF(uvegezes == "3-rétegű (Ug=0.6)", "Swisspacer_WarmEdge", "Alu_Standard_Spacer")',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Távtartó profil: {OUT}.'
    }
  });

  addRule({
    id: 'R-041',
    name: 'Nemesgáz töltet ellenőrzés (Argon 90%)',
    category: '4. Üvegezés és Hőtechnika',
    description: 'Minden hőszigetelő üvegezés Argon 90% töltettel készül.',
    dependencies: ['R-005'],
    conditions: { combinator: 'AND', rules: [{ field: 'uvegezes_megadva', operator: '==', value: true }] },
    output: {
      outputField: 'argon_toltet_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Argon 90% gáztöltet ellenőrizve.'
    }
  });

  addRule({
    id: 'R-042',
    name: 'Üvegtábla vastagság emelés 2.5 m² felett (6 mm float)',
    category: '4. Üvegezés és Hőtechnika',
    description: '2.5 m² feletti felületnél 4 mm helyett 6 mm-es üvegréteg szükséges.',
    ruleType: 'expression',
    dependencies: ['R-011'],
    expression: 'IF(felulet_m2 > 2.5, 6, 4)',
    output: {
      outputField: 'uveg_alapvastagsag_mm',
      outputType: 'calculated',
      expression: 'IF(felulet_m2 > 2.5, 6, 4)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Üvegtábla vastagság: {OUT} mm.'
    }
  });

  addRule({
    id: 'R-043',
    name: 'Akusztikai léghanggátlási érték (Rw dB)',
    category: '4. Üvegezés és Hőtechnika',
    description: 'Meghatározza a várható Rw (dB) hangszigetelési értéket.',
    ruleType: 'expression',
    dependencies: ['R-042'],
    expression: 'IF(uveg_alapvastagsag_mm == 6, 38, 33)',
    output: {
      outputField: 'akusztika_rw_db',
      outputType: 'calculated',
      expression: 'IF(uveg_alapvastagsag_mm == 6, 38, 33)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Hangszigetelés: {OUT} dB.'
    }
  });

  addRule({
    id: 'R-044',
    name: 'Üvegléc geometria kiválasztása',
    category: '4. Üvegezés és Hőtechnika',
    description: 'Keretvastagság és üvegezés alapján kiválasztja az üvegléc profilkódot.',
    ruleType: 'expression',
    dependencies: ['R-007', 'R-036'],
    expression: 'IF(keret_vastagsag_mm >= 80, "GL-82-TRIPLE", "GL-76-STD")',
    output: {
      outputField: 'uvegleckod',
      outputType: 'calculated',
      expression: 'IF(keret_vastagsag_mm >= 80, "GL-82-TRIPLE", "GL-76-STD")',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Üvegléc kód: {OUT}.'
    }
  });

  addRule({
    id: 'R-045',
    name: 'Páraáteresztés és peremtömítés ellenőrzés',
    category: '4. Üvegezés és Hőtechnika',
    description: 'Poliszulfid/poliuretán másodlagos peremtömítés ellenőrzése.',
    dependencies: ['R-036'],
    conditions: { combinator: 'AND', rules: [{ field: 'uveg_keret_kompatibilis', operator: '==', value: true }] },
    output: {
      outputField: 'peremtomites_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Peremtömítés megfelelő.'
    }
  });

  addRule({
    id: 'R-046',
    name: 'Napfaktor (g-érték) besorolás',
    category: '4. Üvegezés és Hőtechnika',
    description: '2-rétegű üvegnél g=0.62, 3-rétegűnél g=0.50.',
    ruleType: 'expression',
    dependencies: ['R-005'],
    expression: 'IF(uvegezes == "3-rétegű (Ug=0.6)", 0.50, 0.62)',
    output: {
      outputField: 'napfaktor_g',
      outputType: 'calculated',
      expression: 'IF(uvegezes == "3-rétegű (Ug=0.6)", 0.50, 0.62)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Napfaktor g={OUT}.'
    }
  });

  addRule({
    id: 'R-047',
    name: 'Összesített üvegezési megfelelőség (Layer 4 szintézis)',
    category: '4. Üvegezés és Hőtechnika',
    description: 'Összesíti az üvegezési és hőtechnikai szabályokat.',
    dependencies: ['R-036', 'R-039', 'R-041', 'R-045'],
    conditions: {
      combinator: 'AND',
      rules: [
        { field: 'uveg_keret_kompatibilis', operator: '==', value: true },
        { field: 'energetika_ok', operator: '==', value: true },
        { field: 'argon_toltet_ok', operator: '==', value: true },
        { field: 'peremtomites_ok', operator: '==', value: true }
      ]
    },
    output: {
      outputField: 'uvegezes_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Üvegezési és hőtechnikai szabályok teljesültek.',
      failMessage: 'Üvegezési vagy hőtechnikai összeférhetetlenség!'
    }
  });

  // =========================================================================
  // LAYER 5: Összesített Gyárthatósági Döntés (R-048 .. R-057) -> produces `gyarthato` ("Igen"/"Nem")
  // =========================================================================
  addRule({
    id: 'R-048',
    name: 'GYÁRTHATÓSÁGI FŐSZABÁLY (Gyártható: Igen / Nem)',
    category: '5. Gyárthatósági Döntés',
    description: 'A Specifikáció 5. fejezete szerinti központi "Gyártható" (Igen / Nem) eredménymező előállítása az adatminőség, geometria, szerkezet és üvegezés alapján.',
    dependencies: ['R-010', 'R-022', 'R-035', 'R-047'],
    conditions: {
      combinator: 'AND',
      rules: [
        { field: 'adat_teljes', operator: '==', value: true },
        { field: 'geometria_ok', operator: '==', value: true },
        { field: 'szerkezet_kompatibilis', operator: '==', value: true },
        { field: 'uvegezes_ok', operator: '==', value: true }
      ]
    },
    output: {
      outputField: 'gyarthato',
      outputType: 'classification',
      trueValue: 'Igen',
      falseValue: 'Nem',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'A termék műszakilag gyártható (Gyártható = Igen).',
      failMessage: 'A termék a megadott paraméterekkel NEM gyártható (Gyártható = Nem)!'
    }
  });

  addRule({
    id: 'R-049',
    name: 'Gyártási útvonal és CNC gépsor kijelölése',
    category: '5. Gyárthatósági Döntés',
    description: 'Kijelöli a gyártósort az alapanyag és a gyárthatóság függvényében.',
    ruleType: 'expression',
    dependencies: ['R-048'],
    expression: 'IF(gyarthato == "Nem", "STOP_HIBAS_TETEL", IF(anyag == "PVC", "CNC_PVC_LINE_1", IF(anyag == "Alu", "CNC_ALU_LINE_2", "WOOD_CRAFT_LINE_3")))',
    output: {
      outputField: 'gyartosor_kod',
      outputType: 'calculated',
      expression: 'IF(gyarthato == "Nem", "STOP_HIBAS_TETEL", IF(anyag == "PVC", "CNC_PVC_LINE_1", IF(anyag == "Alu", "CNC_ALU_LINE_2", "WOOD_CRAFT_LINE_3")))',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Gyártósor: {OUT}.'
    }
  });

  addRule({
    id: 'R-050',
    name: 'Teljes rendelési tételsúly számítása (kg)',
    category: '5. Gyárthatósági Döntés',
    description: 'Egyedi elemsúly szorozva a megrendelt darabszámmal.',
    ruleType: 'expression',
    dependencies: ['R-021'],
    expression: 'ROUND(elem_suly_kg * mennyiseg_db, 1)',
    output: {
      outputField: 'ossz_suly_kg',
      outputType: 'calculated',
      expression: 'ROUND(elem_suly_kg * mennyiseg_db, 1)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Összsúly: {OUT} kg.'
    }
  });

  addRule({
    id: 'R-051',
    name: 'Teljes üvegfelület számítása a tételre (m²)',
    category: '5. Gyárthatósági Döntés',
    description: 'Az egyedi felület és a darabszám szorzata.',
    ruleType: 'expression',
    dependencies: ['R-011'],
    expression: 'ROUND(felulet_m2 * mennyiseg_db, 2)',
    output: {
      outputField: 'ossz_felulet_m2',
      outputType: 'calculated',
      expression: 'ROUND(felulet_m2 * mennyiseg_db, 2)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Összesített felület: {OUT} m².'
    }
  });

  addRule({
    id: 'R-052',
    name: 'Minőségellenőrzési (MEO) szint meghatározása',
    category: '5. Gyárthatósági Döntés',
    description: 'Door B és Sliding Patio D esetén 100%-os próbapad teszt, egyébként szúrópróba.',
    ruleType: 'expression',
    dependencies: ['R-048'],
    expression: 'IF(termek == "Door B" OR termek == "Sliding Patio D", "MEO_100_PROBAPAD", "MEO_STANDARD")',
    output: {
      outputField: 'meo_szint',
      outputType: 'calculated',
      expression: 'IF(termek == "Door B" OR termek == "Sliding Patio D", "MEO_100_PROBAPAD", "MEO_STANDARD")',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'MEO szint: {OUT}.'
    }
  });

  addRule({
    id: 'R-053',
    name: 'Gyártási komplexitási kategória',
    category: '5. Gyárthatósági Döntés',
    description: 'Besorolja a rendelést Standard vagy Egyedi gyártási kategóriába.',
    ruleType: 'expression',
    dependencies: ['R-011', 'R-048'],
    expression: 'IF(felulet_m2 > 2.5 OR anyag != "PVC", "Egyedi_Gyartas", "Standard_Sorozat")',
    output: {
      outputField: 'gyartasi_kategoria',
      outputType: 'calculated',
      expression: 'IF(felulet_m2 > 2.5 OR anyag != "PVC", "Egyedi_Gyartas", "Standard_Sorozat")',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Gyártási kategória: {OUT}.'
    }
  });

  addRule({
    id: 'R-054',
    name: 'Szabászati ráhagyás kalkuláció (mm)',
    category: '5. Gyárthatósági Döntés',
    description: 'PVC hegesztésnél 6 mm/sarok ráhagyás, Alu/Fa esetén 0 mm.',
    ruleType: 'expression',
    dependencies: ['R-004'],
    expression: 'IF(anyag == "PVC", 24, 0)',
    output: {
      outputField: 'hegesztesi_rahagyas_mm',
      outputType: 'calculated',
      expression: 'IF(anyag == "PVC", 24, 0)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Hegesztési ráhagyás: {OUT} mm.'
    }
  });

  addRule({
    id: 'R-055',
    name: 'CE teljesítménynyilatkozat megfelelőség',
    category: '5. Gyárthatósági Döntés',
    description: 'A CE jelölés csak gyártható és energetikailag megfelelő termékre adható ki.',
    dependencies: ['R-039', 'R-048'],
    conditions: {
      combinator: 'AND',
      rules: [
        { field: 'gyarthato', operator: '==', value: 'Igen' },
        { field: 'energetika_ok', operator: '==', value: true }
      ]
    },
    output: {
      outputField: 'ce_minosites_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'CE teljesítménynyilatkozat kiadható.',
      failMessage: 'CE minősítés nem adható ki a hibás műszaki paraméterek miatt!'
    }
  });

  addRule({
    id: 'R-056',
    name: 'Gyári kapacitáspont számítása',
    category: '5. Gyárthatósági Döntés',
    description: 'Minden m² felület 1.5 kapacitáspontot jelent a gyártástervezésben.',
    ruleType: 'expression',
    dependencies: ['R-051'],
    expression: 'ROUND(ossz_felulet_m2 * 1.5, 1)',
    output: {
      outputField: 'kapacitas_pont',
      outputType: 'calculated',
      expression: 'ROUND(ossz_felulet_m2 * 1.5, 1)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Kapacitáspont: {OUT}.'
    }
  });

  addRule({
    id: 'R-057',
    name: 'Műszaki törzslap státusz',
    category: '5. Gyárthatósági Döntés',
    description: 'Összesíti a műszaki gyártás-előkészítés státuszát.',
    dependencies: ['R-048', 'R-055'],
    conditions: {
      combinator: 'AND',
      rules: [
        { field: 'gyarthato', operator: '==', value: 'Igen' },
        { field: 'ce_minosites_ok', operator: '==', value: true }
      ]
    },
    output: {
      outputField: 'muszaki_statusz',
      outputType: 'classification',
      trueValue: 'Engedélyezve',
      falseValue: 'Letiltva',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Műszaki törzslap engedélyezve.',
      failMessage: 'Műszaki törzslap letiltva.'
    }
  });

  // =========================================================================
  // LAYER 6: Cím-, Logisztikai és Csomagolási Ellenőrzés (R-058 .. R-069)
  // Produces `cimellenorzes` ("OK" / "Review") matching Section 5!
  // =========================================================================
  addRule({
    id: 'R-058',
    name: 'CÍMELLENŐRZÉS: Szállítási cím és szerződéses cím egyezése (OK / Review)',
    category: '6. Cím és Logisztika',
    description: 'Specifikáció 5. fejezet: Ha a szállítási cím eltér az ügyfél szerződéses címétől, az eredmény "Review" és "Requires Review" státuszt vált ki (nem műszaki hiba!).',
    dependencies: ['R-002', 'R-009'],
    conditions: {
      combinator: 'AND',
      rules: [
        { field: 'szallitasi_cim', operator: 'equals_field', valueFromField: 'szerzodeses_cim', value: 'szerzodeses_cim' }
      ]
    },
    output: {
      outputField: 'cimellenorzes',
      outputType: 'classification',
      trueValue: 'OK',
      falseValue: 'Review',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Requires Review',
      passMessage: 'Szállítási cím megegyezik a szerződéses címmel (Címellenőrzés = OK).',
      failMessage: 'Címeltérés: a szállítási cím ({szallitasi_cim}) eltér a szerződéses címtől ({szerzodeses_cim}) – emberi felülvizsgálat szükséges (Requires Review).'
    }
  });

  addRule({
    id: 'R-059',
    name: 'Csomagolási mód megfelelősége (Kaloda / Raklap vs. Fólia)',
    category: '6. Cím és Logisztika',
    description: 'Fólia csomagolás törékeny üvegezett nyílászárónál csak saját felelősségre ajánlott (Warning).',
    dependencies: ['R-008'],
    conditions: {
      combinator: 'AND',
      rules: [
        { field: 'csomagolas', operator: 'in', value: ['Kaloda', 'Raklap'] }
      ]
    },
    output: {
      outputField: 'csomagolas_minosites',
      outputType: 'classification',
      trueValue: 'Biztonságos',
      falseValue: 'Sérülékeny (Fólia)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Warning',
      passMessage: 'Merev védőcsomagolás ({csomagolas}).',
      failMessage: 'Figyelmeztetés: Fólia csomagolás választva kaloda/raklap helyett – szállítási sérülésveszély!'
    }
  });

  addRule({
    id: 'R-060',
    name: 'Szállítási határidő észszerűsége (>= 7 munkanap)',
    category: '6. Cím és Logisztika',
    description: '7 napnál rövidebb szállítási határidő sürgősségi felárat és figyelmeztetést jelent.',
    conditions: {
      combinator: 'AND',
      rules: [{ field: 'szallitasi_hatarido_nap', operator: '>=', value: 7 }]
    },
    output: {
      outputField: 'hatarido_statusz',
      outputType: 'classification',
      trueValue: 'Normál',
      falseValue: 'Sürgős (<7 nap)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Warning',
      passMessage: 'Szállítási határidő ({szallitasi_hatarido_nap} nap) normál gyártási ütemben teljesíthető.',
      failMessage: 'Rövid szállítási határidő ({szallitasi_hatarido_nap} nap < 7 nap) – kapacitás-figyelmeztetés!'
    }
  });

  addRule({
    id: 'R-061',
    name: 'Emelőhátfalas / darus rakodási igény (> 150 kg összsúly)',
    category: '6. Cím és Logisztika',
    description: '150 kg összsúly felett gépi rakodás szükséges a kiszállításkor.',
    ruleType: 'expression',
    dependencies: ['R-050'],
    expression: 'IF(ossz_suly_kg > 150, "Gepi_Rakodas_Szukseges", "Kezi_Rakodhato")',
    output: {
      outputField: 'rakodasi_mod',
      outputType: 'calculated',
      expression: 'IF(ossz_suly_kg > 150, "Gepi_Rakodas_Szukseges", "Kezi_Rakodhato")',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Rakodási mód: {OUT}.'
    }
  });

  addRule({
    id: 'R-062',
    name: 'Szállítási zóna érvényesség (REST API referencia)',
    category: '6. Cím és Logisztika',
    description: 'Ellenőrzi, hogy az irányítószám-zóna ismert-e a logisztikai rendszerben.',
    conditions: {
      combinator: 'AND',
      rules: [{ field: 'iranyitoszam_zona', operator: 'in', value: ['HU-CENTRAL', 'HU-EAST', 'HU-SOUTH', 'HU-WEST', 'HU-NORTH'] }]
    },
    output: {
      outputField: 'zona_ervényes',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Warning',
      passMessage: 'Logisztikai zóna ({iranyitoszam_zona}) érvényes.',
      failMessage: 'Ismeretlen logisztikai zóna ({iranyitoszam_zona}).'
    }
  });

  addRule({
    id: 'R-063',
    name: 'Kaloda kapacitás kalkuláció (db kaloda)',
    category: '6. Cím és Logisztika',
    description: 'Minden 5 db nyílászáróhoz 1 db szállítókaloda szükséges.',
    ruleType: 'expression',
    dependencies: ['R-008'],
    expression: 'IF(csomagolas == "Kaloda", ROUND((mennyiseg_db + 4) / 5, 0), 0)',
    output: {
      outputField: 'kaloda_db',
      outputType: 'calculated',
      expression: 'IF(csomagolas == "Kaloda", ROUND((mennyiseg_db + 4) / 5, 0), 0)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Szükséges kalodák száma: {OUT} db.'
    }
  });

  addRule({
    id: 'R-064',
    name: 'Fuvardíj becslés súly és zóna alapján (EUR)',
    category: '6. Cím és Logisztika',
    description: 'Alapdíj (45 EUR) + súlyalapú pótdíj (0.35 EUR/kg).',
    ruleType: 'expression',
    dependencies: ['R-050'],
    expression: 'ROUND(45 + ossz_suly_kg * 0.35, 2)',
    output: {
      outputField: 'becsult_fuvardij_eur',
      outputType: 'calculated',
      expression: 'ROUND(45 + ossz_suly_kg * 0.35, 2)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Becsült fuvardíj: {OUT} EUR.'
    }
  });

  addRule({
    id: 'R-065',
    name: 'Túlméretes szállítási jelölés (> 2100 mm)',
    category: '6. Cím és Logisztika',
    description: '2100 mm feletti élhossz esetén magasított ponyvás tehergépkocsi szükséges.',
    ruleType: 'expression',
    dependencies: ['R-006'],
    expression: 'IF(szelesseg_mm > 2100 OR magassag_mm > 2100, "Magasitott_Jarmu", "Normál_Jarmu")',
    output: {
      outputField: 'jarmu_igeny',
      outputType: 'calculated',
      expression: 'IF(szelesseg_mm > 2100 OR magassag_mm > 2100, "Magasitott_Jarmu", "Normál_Jarmu")',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Járműigény: {OUT}.'
    }
  });

  addRule({
    id: 'R-066',
    name: 'Törékenységi biztosítási kategória',
    category: '6. Cím és Logisztika',
    description: '3-rétegű vagy nagy felületű üvegnél kiemelt szállítási biztosítás.',
    ruleType: 'expression',
    dependencies: ['R-037'],
    expression: 'IF(uveg_biztonsagi_osztaly == "ESG_VSG_Biztonsagi", "Kiemelt_Biztositas", "Alap_Biztositas")',
    output: {
      outputField: 'szallitasi_biztositas',
      outputType: 'calculated',
      expression: 'IF(uveg_biztonsagi_osztaly == "ESG_VSG_Biztonsagi", "Kiemelt_Biztositas", "Alap_Biztositas")',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Szállítási biztosítás: {OUT}.'
    }
  });

  addRule({
    id: 'R-067',
    name: 'Sarokvédő habprofil darabszám',
    category: '6. Cím és Logisztika',
    description: 'Minden megrendelt nyílászáróhoz 4 db sarokvédő szükséges.',
    ruleType: 'expression',
    expression: 'mennyiseg_db * 4',
    output: {
      outputField: 'sarokvedo_db',
      outputType: 'calculated',
      expression: 'mennyiseg_db * 4',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Sarokvédő igény: {OUT} db.'
    }
  });

  addRule({
    id: 'R-068',
    name: 'Párazáró csomagolófólia terület (m²)',
    category: '6. Cím és Logisztika',
    description: 'Az összesített felület 2.2-szerese szükséges a teljes burkoláshoz.',
    ruleType: 'expression',
    dependencies: ['R-051'],
    expression: 'ROUND(ossz_felulet_m2 * 2.2, 1)',
    output: {
      outputField: 'csomagolofolia_m2',
      outputType: 'calculated',
      expression: 'ROUND(ossz_felulet_m2 * 2.2, 1)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Csomagolófólia igény: {OUT} m².'
    }
  });

  addRule({
    id: 'R-069',
    name: 'Összesített logisztikai státusz (Layer 6 szintézis)',
    category: '6. Cím és Logisztika',
    description: 'Összegzi a cím-, csomagolási és határidő-ellenőrzések eredményét.',
    dependencies: ['R-058', 'R-059', 'R-060', 'R-062'],
    conditions: {
      combinator: 'AND',
      rules: [
        { field: 'cimellenorzes', operator: '==', value: 'OK' },
        { field: 'csomagolas_minosites', operator: '==', value: 'Biztonságos' },
        { field: 'hatarido_statusz', operator: '==', value: 'Normál' }
      ]
    },
    output: {
      outputField: 'logisztika_tiszta',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Logisztika és címellenőrzés eltérésmentes.',
      failMessage: 'Logisztikai figyelmeztetés vagy címeltérés található.'
    }
  });

  // =========================================================================
  // LAYER 7: Pénzügyi, Szerződéses és Ügyfélkockázati Szabályok (R-070 .. R-079)
  // =========================================================================
  addRule({
    id: 'R-070',
    name: 'Bruttó tételérték számítása (EUR)',
    category: '7. Pénzügyi és Szerződéses Szabályok',
    description: 'Egységár × mennyiség.',
    ruleType: 'expression',
    expression: 'ROUND(egysegar_eur * mennyiseg_db, 2)',
    output: {
      outputField: 'brutto_tetel_eur',
      outputType: 'calculated',
      expression: 'ROUND(egysegar_eur * mennyiseg_db, 2)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Bruttó tételérték: {OUT} EUR.'
    }
  });

  addRule({
    id: 'R-071',
    name: 'Nettó kedvezményes tételérték számítása (EUR)',
    category: '7. Pénzügyi és Szerződéses Szabályok',
    description: 'Bruttó érték csökkentve a kedvezmény százalékával.',
    ruleType: 'expression',
    dependencies: ['R-070'],
    expression: 'ROUND(brutto_tetel_eur * (100 - kedvezmeny_pct) / 100, 2)',
    output: {
      outputField: 'netto_tetel_eur',
      outputType: 'calculated',
      expression: 'ROUND(brutto_tetel_eur * (100 - kedvezmeny_pct) / 100, 2)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Nettó fizetendő: {OUT} EUR.'
    }
  });

  addRule({
    id: 'R-072',
    name: 'Maximális kedvezmény korlát ellenőrzése (<= 15%)',
    category: '7. Pénzügyi és Szerződéses Szabályok',
    description: '15% feletti kedvezmény kereskedelmi vezetői felülvizsgálatot igényel (Requires Review).',
    conditions: {
      combinator: 'AND',
      rules: [{ field: 'kedvezmeny_pct', operator: '<=', value: 15 }]
    },
    output: {
      outputField: 'kedvezmeny_engedelyezett',
      outputType: 'classification',
      trueValue: 'OK',
      falseValue: 'Felülvizsgálandó (>15%)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Requires Review',
      passMessage: 'A kedvezmény ({kedvezmeny_pct}%) a 15%-os határon belül van.',
      failMessage: 'Magas kedvezmény ({kedvezmeny_pct}% > 15%) – kereskedelmi jóváhagyás szükséges (Requires Review).'
    }
  });

  addRule({
    id: 'R-073',
    name: 'Ügyfélspecifikus szerződéses kedvezménykeret összevetése',
    category: '7. Pénzügyi és Szerződéses Szabályok',
    description: 'Ellenőrzi, hogy a kedvezmény nem lépi-e túl az ügyféltörzsben rögzített max_kedvezmeny_pct értéket.',
    dependencies: ['R-002', 'R-072'],
    conditions: {
      combinator: 'OR',
      rules: [
        { field: 'max_kedvezmeny_pct', operator: 'is_null' },
        { field: 'kedvezmeny_pct', operator: 'lte_field', valueFromField: 'max_kedvezmeny_pct', value: 'max_kedvezmeny_pct' }
      ]
    },
    output: {
      outputField: 'szerzodeses_kedvezmeny_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Requires Review',
      passMessage: 'Kedvezmény megfelel az ügyfélszerződésnek.',
      failMessage: 'A kedvezmény ({kedvezmeny_pct}%) meghaladja az ügyfél szerződéses keretét ({max_kedvezmeny_pct}%)!'
    }
  });

  addRule({
    id: 'R-074',
    name: 'Minimális fajlagos négyzetméterár ellenőrzés (>= 110 EUR/m²)',
    category: '7. Pénzügyi és Szerződéses Szabályok',
    description: 'Önköltség alatti értékesítés kiszűrése.',
    ruleType: 'expression',
    dependencies: ['R-011'],
    expression: 'ROUND(egysegar_eur / felulet_m2, 2)',
    output: {
      outputField: 'fajlagos_ar_eur_m2',
      outputType: 'calculated',
      expression: 'ROUND(egysegar_eur / felulet_m2, 2)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Fajlagos ár: {OUT} EUR/m².'
    }
  });

  addRule({
    id: 'R-075',
    name: 'Fedezeti minimum ellenőrzése (fajlagos ár >= 95 EUR/m²)',
    category: '7. Pénzügyi és Szerződéses Szabályok',
    description: 'Ha a fajlagos ár 95 EUR/m² alá esik, figyelmeztetést ad alacsony fedezetre.',
    dependencies: ['R-074'],
    conditions: {
      combinator: 'AND',
      rules: [{ field: 'fajlagos_ar_eur_m2', operator: '>=', value: 95 }]
    },
    output: {
      outputField: 'fedezet_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Warning',
      passMessage: 'Fajlagos fedezet megfelelő ({fajlagos_ar_eur_m2} EUR/m²).',
      failMessage: 'Alacsony fajlagos ár ({fajlagos_ar_eur_m2} EUR/m² < 95 EUR/m²)!'
    }
  });

  addRule({
    id: 'R-076',
    name: 'Egyedi gyártási előlegigény (50%) meghatározása',
    category: '7. Pénzügyi és Szerződéses Szabályok',
    description: 'Egyedi gyártású tételeknél 50% előlegbekérő generálandó.',
    ruleType: 'expression',
    dependencies: ['R-053', 'R-071'],
    expression: 'IF(gyartasi_kategoria == "Egyedi_Gyartas", ROUND(netto_tetel_eur * 0.5, 2), 0)',
    output: {
      outputField: 'eloleg_igeny_eur',
      outputType: 'calculated',
      expression: 'IF(gyartasi_kategoria == "Egyedi_Gyartas", ROUND(netto_tetel_eur * 0.5, 2), 0)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Előlegigény: {OUT} EUR.'
    }
  });

  addRule({
    id: 'R-077',
    name: 'Ügyfél összesített rendelésállomány és hitelkeret ellenőrzés (Aggregáció)',
    category: '7. Pénzügyi és Szerződéses Szabályok',
    description: 'Több rekordot érintő aggregáció: ellenőrzi az ügyfél összes rendelésének értékét a hitelkeretéhez képest.',
    dependencies: ['R-002', 'R-071'],
    conditions: {
      combinator: 'OR',
      rules: [
        { field: 'hitelkeret_eur', operator: 'is_null' },
        { field: 'ugyfel_ossz_rendeles_eur', operator: 'lte_field', valueFromField: 'hitelkeret_eur', value: 'hitelkeret_eur' }
      ]
    },
    output: {
      outputField: 'hitelkeret_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Warning',
      passMessage: 'Ügyfél hitelkeret ({hitelkeret_eur} EUR) nem került túllépésre.',
      failMessage: 'Az ügyfél halmozott rendelésállománya ({ugyfel_ossz_rendeles_eur} EUR) meghaladja a hitelkeretet ({hitelkeret_eur} EUR)!'
    }
  });

  addRule({
    id: 'R-078',
    name: 'Ügyfélszerződés aktív státuszának ellenőrzése',
    category: '7. Pénzügyi és Szerződéses Szabályok',
    description: 'Az ügyfél keretszerződésének "Aktív" állapotúnak kell lennie.',
    dependencies: ['R-002'],
    conditions: {
      combinator: 'AND',
      rules: [{ field: 'szerzodes_statusz', operator: '==', value: 'Aktív' }]
    },
    output: {
      outputField: 'szerzodes_aktiv_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Ügyfél keretszerződése Aktív.',
      failMessage: 'Az ügyfél keretszerződése nem aktív ({szerzodes_statusz})!'
    }
  });

  addRule({
    id: 'R-079',
    name: 'Összesített pénzügyi megfelelőség (Layer 7 szintézis)',
    category: '7. Pénzügyi és Szerződéses Szabályok',
    description: 'Összesíti a pénzügyi, árképzési és szerződéses szabályok eredményét.',
    dependencies: ['R-072', 'R-073', 'R-075', 'R-077', 'R-078'],
    conditions: {
      combinator: 'AND',
      rules: [
        { field: 'kedvezmeny_engedelyezett', operator: '==', value: 'OK' },
        { field: 'szerzodeses_kedvezmeny_ok', operator: '==', value: true },
        { field: 'fedezet_ok', operator: '==', value: true },
        { field: 'hitelkeret_ok', operator: '==', value: true },
        { field: 'szerzodes_aktiv_ok', operator: '==', value: true }
      ]
    },
    output: {
      outputField: 'penzugyi_statusz_ok',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Pénzügyi és szerződéses feltételek rendben.',
      failMessage: 'Pénzügyi vagy szerződéses eltérés található.'
    }
  });

  // =========================================================================
  // LAYER 8: Végső Státusz- és Kivételelemzés + Lifecycle Példák (R-080 .. R-085)
  // =========================================================================
  addRule({
    id: 'R-080',
    name: 'VÉGSŐ KOMPOZIT MINŐSÍTÉS ÉS KIVÉTEL-BESOROLÁS (Layer 8 csúcsszabály)',
    category: '8. Végső Minősítés és Audit',
    description: 'A teljes 80 szabályból álló függőségi háló csúcsszabálya: egyesíti a Gyárthatóság (R-048), Címellenőrzés (R-058), Logisztika (R-069) és Pénzügy (R-079) eredményét.',
    ruleType: 'expression',
    dependencies: ['R-048', 'R-058', 'R-069', 'R-079'],
    expression: 'IF(gyarthato == "Nem", "HIBA_NEM_GYARTHATO", IF(cimellenorzes == "Review" OR penzugyi_statusz_ok == false, "FELULVIZSGALAT_SZUKSEGES", IF(logisztika_tiszta == false, "FIGYELMEZTETESSEL_ELFOGADVA", "AUTOMATIKUSAN_ELFOGADVA")))',
    output: {
      outputField: 'vegso_minosites',
      outputType: 'calculated',
      expression: 'IF(gyarthato == "Nem", "HIBA_NEM_GYARTHATO", IF(cimellenorzes == "Review" OR penzugyi_statusz_ok == false, "FELULVIZSGALAT_SZUKSEGES", IF(logisztika_tiszta == false, "FIGYELMEZTETESSEL_ELFOGADVA", "AUTOMATIKUSAN_ELFOGADVA")))',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Végső kompozit minősítés: {OUT}.'
    }
  });

  // R-081 & R-082: Rules in 'Test' lifecycle status (ready for user testing & promotion to Prod)
  addRule({
    id: 'R-081',
    name: 'Kísérleti passzívház Uw <= 0.80 W/m²K prémium minősítés',
    category: '8. Végső Minősítés és Audit',
    description: 'Teszt fázisban lévő szabály: megjelöli a passzívház-minősítésű (Uw <= 0.80) nyílászárókat.',
    lifecycleStatus: 'Test',
    validationStatus: 'Passed',
    dependencies: ['R-038'],
    conditions: { combinator: 'AND', rules: [{ field: 'uw_ertek', operator: '<=', value: 0.80 }] },
    output: {
      outputField: 'passzivhaz_alkalmas',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Passzívház minősítésnek megfelel.'
    }
  });

  addRule({
    id: 'R-082',
    name: 'Extra nagyméretű szállítmány (> 10 m² összfelület) flottatervezés',
    category: '8. Végső Minősítés és Audit',
    description: 'Teszt alatt álló logisztikai szabály nagy összfelületű megrendelésekhez.',
    lifecycleStatus: 'Test',
    validationStatus: 'Passed',
    dependencies: ['R-051'],
    conditions: { combinator: 'AND', rules: [{ field: 'ossz_felulet_m2', operator: '<=', value: 10.0 }] },
    output: {
      outputField: 'flotta_normal_kapacitas',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Normál flottakapacitás.'
    }
  });

  // R-083 & R-084: Rules in 'Draft' lifecycle status
  addRule({
    id: 'R-083',
    name: 'Tervezet: Karbonlábnyom (CO2 kg) becslés felület alapján',
    category: '8. Végső Minősítés és Audit',
    description: 'Draft állapotú szabály az ESG fenntarthatósági jelentéshez.',
    lifecycleStatus: 'Draft',
    validationStatus: 'Untested',
    ruleType: 'expression',
    dependencies: ['R-051'],
    expression: 'ROUND(ossz_felulet_m2 * 18.5, 1)',
    output: {
      outputField: 'becsult_co2_kg',
      outputType: 'calculated',
      expression: 'ROUND(ossz_felulet_m2 * 18.5, 1)',
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'CO2 lábnyom: {OUT} kg.'
    }
  });

  addRule({
    id: 'R-084',
    name: 'Tervezet: Különleges RAL szín felár ellenőrzés',
    category: '8. Végső Minősítés és Audit',
    description: 'Draft szabály egyedi színfelár vizsgálatához.',
    lifecycleStatus: 'Draft',
    validationStatus: 'Untested',
    conditions: { combinator: 'AND', rules: [{ field: 'szin', operator: 'is_not_null' }] },
    output: {
      outputField: 'szin_felar_ellenorzott',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Accepted',
      passMessage: 'Szín ellenőrizve.'
    }
  });

  // R-085: Rule in 'Retired' lifecycle status (Section 9.1: Kivont, de visszakövethető szabály)
  addRule({
    id: 'R-085',
    name: 'Kivont (2025): Régi 1-rétegű üvegezés tiltása',
    category: '8. Végső Minősítés és Audit',
    description: 'Kivont (Retired) történeti szabály, amely audit célból visszakövethető marad.',
    lifecycleStatus: 'Retired',
    validationStatus: 'Passed',
    version: 2,
    conditions: { combinator: 'AND', rules: [{ field: 'uvegezes', operator: 'not_contains', value: '1-rétegű' }] },
    output: {
      outputField: 'regi_uveg_tiltas',
      outputType: 'boolean',
      trueValue: true,
      falseValue: false,
      onTrueStatus: 'Accepted',
      onFalseStatus: 'Error',
      passMessage: 'Nem 1-rétegű üveg.'
    }
  });

  // Sync full implicit + explicit dependencies across all 85 rules
  const { dependenciesOf } = buildDependencyGraph(rules);
  for (const r of rules) {
    r.dependencies = Array.from(dependenciesOf.get(r.id) || []);
  }

  return rules;
}

/**
 * Seeds the SQLite database with Use Case 1 (Window & Door Order Validation - 85 rules, 105 orders, 4 data sources, 8 test cases),
 * Use Case 2 (Shipment Validation), and Use Case 3 (Supplier Data Verification).
 */
function seedDatabase(db, forceReset = false) {
  const existingCount = db.prepare('SELECT COUNT(*) as cnt FROM use_cases').get().cnt;
  if (existingCount > 0 && !forceReset) {
    return;
  }

  db.exec(`
    DELETE FROM audit_logs;
    DELETE FROM human_reviews;
    DELETE FROM record_results;
    DELETE FROM execution_runs;
    DELETE FROM test_cases;
    DELETE FROM rule_versions;
    DELETE FROM rules;
    DELETE FROM data_sources;
    DELETE FROM use_cases;
    DELETE FROM external_sql_catalog;
  `);

  const now = '2026-11-10T09:00:00.000Z';

  // Populate external SQLite catalog table (`external_sql_catalog`)
  const sqlCatalogRows = [
    { sku_code: 'Window A', product_family: 'Bukó-nyíló ablak', material_grade: 'A-Class', min_width_mm: 400, max_width_mm: 2400, min_height_mm: 400, max_height_mm: 2400, max_area_m2: 4.5, min_frame_depth_mm: 70, standard_lead_days: 10, active_in_factory: 1 },
    { sku_code: 'Window C', product_family: 'Panoráma ablak', material_grade: 'A-Class', min_width_mm: 500, max_width_mm: 2400, min_height_mm: 500, max_height_mm: 2400, max_area_m2: 5.0, min_frame_depth_mm: 76, standard_lead_days: 12, active_in_factory: 1 },
    { sku_code: 'Door B', product_family: 'Bejárati ajtó', material_grade: 'Reinforced', min_width_mm: 800, max_width_mm: 2200, min_height_mm: 1900, max_height_mm: 2400, max_area_m2: 4.2, min_frame_depth_mm: 76, standard_lead_days: 14, active_in_factory: 1 },
    { sku_code: 'Sliding Patio D', product_family: 'Emelő-toló erkélyajtó', material_grade: 'Heavy-Alu', min_width_mm: 1500, max_width_mm: 2400, min_height_mm: 1900, max_height_mm: 2400, max_area_m2: 5.0, min_frame_depth_mm: 76, standard_lead_days: 15, active_in_factory: 1 },
    { sku_code: 'Roof Window E', product_family: 'Tetősík ablak', material_grade: 'Thermo-Pro', min_width_mm: 500, max_width_mm: 1600, min_height_mm: 600, max_height_mm: 1800, max_area_m2: 2.8, min_frame_depth_mm: 70, standard_lead_days: 10, active_in_factory: 1 }
  ];

  const insertSqlCat = db.prepare(`
    INSERT INTO external_sql_catalog (sku_code, product_family, material_grade, min_width_mm, max_width_mm, min_height_mm, max_height_mm, max_area_m2, min_frame_depth_mm, standard_lead_days, active_in_factory)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of sqlCatalogRows) {
    insertSqlCat.run(r.sku_code, r.product_family, r.material_grade, r.min_width_mm, r.max_width_mm, r.min_height_mm, r.max_height_mm, r.max_area_m2, r.min_frame_depth_mm, r.standard_lead_days, r.active_in_factory);
  }

  // =========================================================================
  // USE CASE 1: Nyílászáró-rendelésellenőrzés (Flagship Use Case from Spec Section 5)
  // =========================================================================
  const uc1Id = 'UC-WINDOW-ORDERS';
  const uc1Mapping = {
    primaryKey: 'rendeles_szam',
    primarySourceId: 'DS-ORDERS',
    displayColumns: [
      { key: 'rendeles_szam', header: 'Rendelés', source: 'source' },
      { key: 'termek', header: 'Termék', source: 'source' },
      { key: 'anyag', header: 'Anyag', source: 'source' },
      { key: 'szelesseg_mm', header: 'Szélesség (mm)', source: 'source' },
      { key: 'magassag_mm', header: 'Magasság (mm)', source: 'source' },
      { key: 'uvegezes', header: 'Üvegezés', source: 'source' },
      { key: 'gyarthato', header: 'Gyártható', source: 'enriched', highlight: true },
      { key: 'cimellenorzes', header: 'Címellenőrzés', source: 'enriched', highlight: true },
      { key: 'felulet_m2', header: 'Felület (m²)', source: 'enriched' },
      { key: 'netto_tetel_eur', header: 'Nettó érték (€)', source: 'enriched' },
      { key: 'vegso_minosites', header: 'Végső minősítés', source: 'enriched' }
    ],
    relationships: [
      {
        id: 'REL-CUSTOMER',
        name: 'Ügyfél és Szerződéses Törzsadat Kapcsolat',
        sourceKey: 'ugyfel_kod',
        targetSourceId: 'DS-CUSTOMERS',
        targetKey: 'ugyfel_kod',
        fieldPrefix: '',
        onMissing: 'null',
        onMultiple: 'first'
      },
      {
        id: 'REL-SQL-CATALOG',
        name: 'SQL Gyártási Katalógus és Méretkorlátok',
        sourceKey: 'termek',
        targetSourceId: 'DS-SQL-CATALOG',
        targetKey: 'sku_code',
        fieldPrefix: 'sql_',
        onMissing: 'null',
        onMultiple: 'first'
      },
      {
        id: 'REL-LOGISTICS',
        name: 'REST API Logisztikai Zóna és Rakodási Szabályok',
        sourceKey: 'iranyitoszam_zona',
        targetSourceId: 'DS-REST-LOGISTICS',
        targetKey: 'zona_kod',
        fieldPrefix: 'log_',
        onMissing: 'null',
        onMultiple: 'first'
      }
    ],
    crossRecordAggregations: [
      {
        id: 'AGG-CUST-TOTAL',
        name: 'Ügyfél összesített rendelési értéke a kötegben (EUR)',
        groupByField: 'ugyfel_kod',
        aggregateField: 'egysegar_eur',
        fn: 'sum',
        outputField: 'ugyfel_ossz_rendeles_eur'
      },
      {
        id: 'AGG-CUST-COUNT',
        name: 'Ügyfél rendeléseinek darabszáma a kötegben',
        groupByField: 'ugyfel_kod',
        aggregateField: 'mennyiseg_db',
        fn: 'count',
        outputField: 'ugyfel_rendeles_szam_db'
      }
    ]
  };

  db.prepare(`
    INSERT INTO use_cases (id, name, code, description, category, mapping_config_json, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uc1Id,
    'Nyílászáró-rendelésellenőrzés (Order Validation)',
    'ORDER_VALIDATION_V1',
    'Megrendelések műszaki gyárthatósági, méret-, üvegezési, szállítási cím és szerződéses feltétel ellenőrzése 85 egymásra épülő üzleti szabállyal (Specifikáció 5. fejezet).',
    'Order & Manufacturing Validation',
    JSON.stringify(uc1Mapping),
    1,
    now,
    now
  );

  // Data Sources for UC1
  const ordersData = buildWindowOrderRecords();
  const customersData = [
    { ugyfel_kod: 'CUST-01', ugyfel_nev: 'Alfa Építőipari Zrt.', szerzodeses_cim: '1117 Budapest, Irinyi József u. 4.', hitelkeret_eur: 150000, max_kedvezmeny_pct: 12, szerzodes_statusz: 'Aktív' },
    { ugyfel_kod: 'CUST-02', ugyfel_nev: 'Kelet-Magyarországi Lakáspark Kft.', szerzodeses_cim: '4025 Debrecen, Piac u. 18.', hitelkeret_eur: 120000, max_kedvezmeny_pct: 10, szerzodes_statusz: 'Aktív' },
    { ugyfel_kod: 'CUST-03', ugyfel_nev: 'Dél-Alföldi Nyílászáró Centrum Kft.', szerzodeses_cim: '6720 Szeged, Kárász u. 12.', hitelkeret_eur: 95000, max_kedvezmeny_pct: 15, szerzodes_statusz: 'Aktív' },
    { ugyfel_kod: 'CUST-04', ugyfel_nev: 'Arrabona Projekt Kivitelező Kft.', szerzodeses_cim: '9021 Győr, Baross Gábor út 10.', hitelkeret_eur: 110000, max_kedvezmeny_pct: 12, szerzodes_statusz: 'Aktív' },
    { ugyfel_kod: 'CUST-05', ugyfel_nev: 'Mecsek Bau Invest Zrt.', szerzodeses_cim: '7621 Pécs, Király u. 8.', hitelkeret_eur: 85000, max_kedvezmeny_pct: 10, szerzodes_statusz: 'Aktív' },
    { ugyfel_kod: 'CUST-06', ugyfel_nev: 'Borsod Konstrukt Kft.', szerzodeses_cim: '3525 Miskolc, Széchenyi István út 22.', hitelkeret_eur: 75000, max_kedvezmeny_pct: 10, szerzodes_statusz: 'Aktív' }
  ];
  const restLogisticsData = [
    { zona_kod: 'HU-CENTRAL', regió_nev: 'Közép-Magyarország', alap_fuvardij_eur: 40, max_tomeg_kg: 3500, daru_elerheto: true },
    { zona_kod: 'HU-EAST', regió_nev: 'Észak-Alföld / Kelet', alap_fuvardij_eur: 65, max_tomeg_kg: 3500, daru_elerheto: true },
    { zona_kod: 'HU-SOUTH', regió_nev: 'Dél-Alföld & Dél-Dunántúl', alap_fuvardij_eur: 60, max_tomeg_kg: 3500, daru_elerheto: true },
    { zona_kod: 'HU-WEST', regió_nev: 'Nyugat-Dunántúl', alap_fuvardij_eur: 55, max_tomeg_kg: 3500, daru_elerheto: true },
    { zona_kod: 'HU-NORTH', regió_nev: 'Észak-Magyarország', alap_fuvardij_eur: 60, max_tomeg_kg: 3500, daru_elerheto: true }
  ];

  const insertDs = db.prepare(`
    INSERT INTO data_sources (
      id, use_case_id, name, source_type, is_primary,
      connection_config_json, schema_fields_json, records_json, sha256_checksum, record_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const uc1Sources = [
    {
      id: 'DS-ORDERS',
      name: 'Megrendelések Fő Adathalmaz (Excel / CSV)',
      source_type: 'excel_csv',
      is_primary: 1,
      config: { fileName: 'nyilaszaro_megrendelesek_2026_11.xlsx', sheet: 'Megrendelések', encoding: 'UTF-8' },
      records: ordersData
    },
    {
      id: 'DS-CUSTOMERS',
      name: 'Ügyfél- és Szerződéses Referencia Törzsadat',
      source_type: 'reference_data',
      is_primary: 0,
      config: { tableCode: 'REF_CUSTOMER_CONTRACTS',lookupKey: 'ugyfel_kod' },
      records: customersData
    },
    {
      id: 'DS-SQL-CATALOG',
      name: 'Gyártási Termékkatalógus (SQLite Adatbázis Tábla)',
      source_type: 'sqlite_table',
      is_primary: 0,
      config: { tableName: 'external_sql_catalog', query: 'SELECT * FROM external_sql_catalog WHERE active_in_factory = 1' },
      records: sqlCatalogRows
    },
    {
      id: 'DS-REST-LOGISTICS',
      name: 'Logisztikai Zóna és Fuvardíj Szolgáltatás (REST API)',
      source_type: 'rest_api',
      is_primary: 0,
      config: { endpoint: '/api/mock-external/logistics-zones', method: 'GET', timeoutMs: 2000 },
      records: restLogisticsData
    }
  ];

  for (const ds of uc1Sources) {
    const schemaFields = ds.records.length > 0
      ? Object.keys(ds.records[0]).map(k => ({ name: k, type: typeof ds.records[0][k] }))
      : [];
    insertDs.run(
      ds.id,
      uc1Id,
      ds.name,
      ds.source_type,
      ds.is_primary,
      JSON.stringify(ds.config),
      JSON.stringify(schemaFields),
      JSON.stringify(ds.records),
      computeDeterministicHash(ds.records),
      ds.records.length,
      now
    );
  }

  // Save all 85 rules for UC1
  const uc1Rules = buildWindowValidationRules();
  for (const rule of uc1Rules) {
    saveRuleToDb(db, uc1Id, rule, 'Kovács Anna (Üzleti Szabálygazda)');
  }

  // Create the 8 User Test Cases (including exact T01..T04 from Section 10!)
  const uc1Tests = [
    {
      id: 'TC-01',
      test_code: 'T01',
      name: 'Megengedett anyag és méret (Window A – 1001)',
      category: 'Normál (Pozitív)',
      description: 'Specifikáció 10. fejezet T01: Megengedett PVC anyag, 1200x1400 mm méret és egyező szállítási cím.',
      target_rule_id: 'ALL_PROD',
      input_data: {
        rendeles_szam: '1001',
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
        iranyitoszam_zona: 'HU-CENTRAL',
        szallitasi_hatarido_nap: 14,
        kedvezmeny_pct: 5,
        egysegar_eur: 340,
        mennyiseg_db: 2
      },
      expected_status: 'Accepted',
      expected_outputs: { gyarthato: 'Igen', cimellenorzes: 'OK' }
    },
    {
      id: 'TC-02',
      test_code: 'T02',
      name: 'Nem megengedett méret (Door B – 1002)',
      category: 'Negatív (Szabálysértő)',
      description: 'Specifikáció 10. fejezet T02: Nem megengedett méret (2650x2450 mm) és PVC Door B kombináció.',
      target_rule_id: 'ALL_PROD',
      input_data: {
        rendeles_szam: '1002',
        ugyfel_kod: 'CUST-02',
        termek: 'Door B',
        anyag: 'PVC',
        szin: 'Antracit (RAL 7016)',
        uvegezes: '3-rétegű (Ug=0.6)',
        keret_vastagsag_mm: 76,
        szelesseg_mm: 2650,
        magassag_mm: 2450,
        csomagolas: 'Kaloda',
        szallitasi_cim: '4025 Debrecen, Piac u. 18.',
        iranyitoszam_zona: 'HU-EAST',
        szallitasi_hatarido_nap: 18,
        kedvezmeny_pct: 6,
        egysegar_eur: 890,
        mennyiseg_db: 1
      },
      expected_status: 'Error',
      expected_outputs: { gyarthato: 'Nem', cimellenorzes: 'OK' }
    },
    {
      id: 'TC-03',
      test_code: 'T03',
      name: 'Eltérő szállítási cím (Window C – 1003)',
      category: 'Kivétel / Felülvizsgálat',
      description: 'Specifikáció 10. fejezet T03: Műszakilag gyártható rendelés, de eltérő szállítási címmel.',
      target_rule_id: 'ALL_PROD',
      input_data: {
        rendeles_szam: '1003',
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
        iranyitoszam_zona: 'HU-SOUTH',
        szallitasi_hatarido_nap: 15,
        kedvezmeny_pct: 8,
        egysegar_eur: 560,
        mennyiseg_db: 3
      },
      expected_status: 'Requires Review',
      expected_outputs: { gyarthato: 'Igen', cimellenorzes: 'Review' }
    },
    {
      id: 'TC-04',
      test_code: 'T04',
      name: 'Hiányzó referenciaadat (Ismeretlen ügyfélkód)',
      category: 'Hiányzó adat',
      description: 'Specifikáció 10. fejezet T04: Hiányzó ügyfél-referencia a szerződéses törzsadatban.',
      target_rule_id: 'ALL_PROD',
      input_data: {
        rendeles_szam: 'TEST-9004',
        ugyfel_kod: 'MISSING-CUST-99',
        termek: 'Window A',
        anyag: 'PVC',
        szin: 'Fehér (RAL 9016)',
        uvegezes: '2-rétegű (Ug=1.1)',
        keret_vastagsag_mm: 76,
        szelesseg_mm: 1100,
        magassag_mm: 1300,
        csomagolas: 'Kaloda',
        szallitasi_cim: '1117 Budapest, Irinyi József u. 4.',
        iranyitoszam_zona: 'HU-CENTRAL',
        szallitasi_hatarido_nap: 14,
        kedvezmeny_pct: 5,
        egysegar_eur: 310,
        mennyiseg_db: 1
      },
      expected_status: 'Error',
      expected_outputs: { ugyfel_referencia_ok: false, gyarthato: 'Nem' }
    },
    {
      id: 'TC-05',
      test_code: 'T05',
      name: 'Keskeny keret (60 mm) + 3-rétegű üvegezés összeférhetetlenség',
      category: 'Ellentmondásos kombináció',
      description: '3-rétegű üvegezés nem építhető be 70 mm alatti keretvastagságba (R-036 -> R-047 -> R-048).',
      target_rule_id: 'R-036',
      input_data: {
        rendeles_szam: 'TEST-9005',
        ugyfel_kod: 'CUST-01',
        termek: 'Window A',
        anyag: 'PVC',
        szin: 'Fehér (RAL 9016)',
        uvegezes: '3-rétegű (Ug=0.6)',
        keret_vastagsag_mm: 60,
        szelesseg_mm: 1000,
        magassag_mm: 1200,
        csomagolas: 'Kaloda',
        szallitasi_cim: '1117 Budapest, Irinyi József u. 4.',
        iranyitoszam_zona: 'HU-CENTRAL',
        szallitasi_hatarido_nap: 14,
        kedvezmeny_pct: 5,
        egysegar_eur: 320,
        mennyiseg_db: 1
      },
      expected_status: 'Error',
      expected_outputs: { uveg_keret_kompatibilis: false, gyarthato: 'Nem' }
    },
    {
      id: 'TC-06',
      test_code: 'T06',
      name: 'Felső mérethatár (Határérték 2400 mm szélesség Alu profillal)',
      category: 'Határérték (Boundary)',
      description: 'Pontosan 2400 mm-es szélességű Alu Window C még éppen megengedett.',
      target_rule_id: 'R-017',
      input_data: {
        rendeles_szam: 'TEST-9006',
        ugyfel_kod: 'CUST-01',
        termek: 'Window C',
        anyag: 'Alu',
        szin: 'Ezüst eloxált',
        uvegezes: '2-rétegű (Ug=1.1)',
        keret_vastagsag_mm: 82,
        szelesseg_mm: 2400,
        magassag_mm: 1500,
        csomagolas: 'Kaloda',
        szallitasi_cim: '1117 Budapest, Irinyi József u. 4.',
        iranyitoszam_zona: 'HU-CENTRAL',
        szallitasi_hatarido_nap: 14,
        kedvezmeny_pct: 5,
        egysegar_eur: 680,
        mennyiseg_db: 1
      },
      expected_status: 'Accepted',
      expected_outputs: { max_szelesseg_ok: true, gyarthato: 'Igen' }
    }
  ];

  const insertTc = db.prepare(`
    INSERT INTO test_cases (
      id, use_case_id, test_code, name, category, description, target_rule_id,
      input_data_json, expected_status, expected_outputs_json, user_confirmed,
      last_run_actual_status, last_run_actual_outputs_json, last_run_passed, last_run_trace_json,
      last_run_at, approved_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const dataSourcesForExec = uc1Sources.map(s => ({ id: s.id, name: s.name, records: s.records }));

  for (const tc of uc1Tests) {
    const singleRun = executeDeterministicPipeline({
      primaryRecords: [tc.input_data],
      dataSources: dataSourcesForExec,
      mappingConfig: uc1Mapping,
      rules: uc1Rules,
      mode: 'prod'
    });
    const recRes = singleRun.recordResults[0];
    let passed = recRes.finalStatus === tc.expected_status;
    if (tc.expected_outputs) {
      for (const [k, expV] of Object.entries(tc.expected_outputs)) {
        if (String(recRes.enrichedData[k]) !== String(expV)) {
          passed = false;
        }
      }
    }

    insertTc.run(
      tc.id,
      uc1Id,
      tc.test_code,
      tc.name,
      tc.category,
      tc.description,
      tc.target_rule_id,
      JSON.stringify(tc.input_data),
      tc.expected_status,
      JSON.stringify(tc.expected_outputs || {}),
      1,
      recRes.finalStatus,
      JSON.stringify(recRes.enrichedData),
      passed ? 1 : 0,
      JSON.stringify(recRes.ruleTraces.slice(0, 15)),
      now,
      'Kovács Anna (Üzleti Szabálygazda)',
      now
    );
  }

  // Execute initial Production Run for UC1 so Results and Human Verification are populated out of the box
  const initialRun = executeDeterministicPipeline({
    primaryRecords: ordersData,
    dataSources: dataSourcesForExec,
    mappingConfig: uc1Mapping,
    rules: uc1Rules,
    mode: 'prod'
  });

  const runId = 'RUN-20261110-001';
  db.prepare(`
    INSERT INTO execution_runs (
      run_id, use_case_id, mode, executed_by, record_count, executed_rule_count, duration_ms,
      source_hash_before, source_hash_after, source_unchanged, deterministic_output_hash,
      rule_versions_snapshot_json, status_counts_json, pipeline_steps_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    uc1Id,
    'prod',
    'Kovács Anna (Üzleti Szabálygazda)',
    initialRun.recordCount,
    initialRun.executedRuleCount,
    initialRun.durationMs,
    initialRun.sourceHashBefore,
    initialRun.sourceHashAfter,
    initialRun.sourceDataUnchanged ? 1 : 0,
    initialRun.deterministicOutputHash,
    JSON.stringify(initialRun.ruleVersionsSnapshot),
    JSON.stringify(initialRun.statusCounts),
    JSON.stringify(initialRun.pipelineSteps),
    now
  );

  const insertRecRes = db.prepare(`
    INSERT INTO record_results (
      run_id, use_case_id, record_id, row_index, source_data_json, joined_data_json,
      enriched_data_json, final_status, requires_human_review, status_reason,
      deviations_json, rule_traces_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const rr of initialRun.recordResults) {
    insertRecRes.run(
      runId,
      uc1Id,
      rr.recordId,
      rr.rowIndex,
      JSON.stringify(rr.sourceData),
      JSON.stringify(rr.joinedData),
      JSON.stringify(rr.enrichedData),
      rr.finalStatus,
      rr.requiresHumanReview ? 1 : 0,
      rr.statusReason,
      JSON.stringify(rr.deviations),
      JSON.stringify(rr.ruleTraces)
    );
  }

  // Seed initial Human Verification decisions on 1002 and 1003 to showcase Section 13 & SC-12
  const insertReview = db.prepare(`
    INSERT INTO human_reviews (run_id, use_case_id, record_id, original_rule_status, decision, comment, reviewed_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertReview.run(
    runId,
    uc1Id,
    '1003',
    'Requires Review',
    'Approved Exception',
    'Ügyféllel telefonon egyeztetve: a 6720 Szeged, Tisza Lajos krt. 55. az igazolt építési helyszín. Eredeti szabályeredmény megőrzése mellett kiszállításra jóváhagyva.',
    'Nagy Gábor (Logisztikai és Kockázati Ellenőr)',
    now
  );

  insertReview.run(
    runId,
    uc1Id,
    '1002',
    'Error',
    'Confirmed Reject',
    'Műszakilag nem gyártható (2650x2450 mm Door B PVC). A megrendelés elutasítása megerősítve, ajánlatkérés visszaküldve tokosztott Alu szerkezetre.',
    'Kovács Anna (Üzleti Szabálygazda)',
    now
  );

  // =========================================================================
  // USE CASE 2: Szállítmány- és Logisztikai Ellenőrzés (Shipment Validation - SC-01)
  // =========================================================================
  const uc2Id = 'UC-SHIPMENT-VALIDATION';
  const uc2Mapping = {
    primaryKey: 'szallitmany_id',
    primarySourceId: 'DS-SHIPMENTS',
    displayColumns: [
      { key: 'szallitmany_id', header: 'Szállítmány ID', source: 'source' },
      { key: 'fuvarozo_kod', header: 'Fuvarozó', source: 'source' },
      { key: 'celorszag', header: 'Célország', source: 'source' },
      { key: 'brutto_tomeg_kg', header: 'Tömeg (kg)', source: 'source' },
      { key: 'adr_veszelyes', header: 'ADR', source: 'source' },
      { key: 'tomeg_megfelelo', header: 'Tömeg OK', source: 'enriched', highlight: true },
      { key: 'vam_ellenorzes', header: 'Vám / ADR Státusz', source: 'enriched', highlight: true }
    ],
    relationships: [
      {
        id: 'REL-CARRIER',
        name: 'Fuvarozó Engedély és Flotta Referencia',
        sourceKey: 'fuvarozo_kod',
        targetSourceId: 'DS-CARRIERS',
        targetKey: 'fuvarozo_kod',
        fieldPrefix: 'car_',
        onMissing: 'flag_error',
        onMultiple: 'first'
      }
    ],
    crossRecordAggregations: []
  };

  db.prepare(`
    INSERT INTO use_cases (id, name, code, description, category, mapping_config_json, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uc2Id,
    'Nemzetközi Szállítmány- és Vámellenőrzés (Shipment Validation)',
    'SHIPMENT_VALIDATION_V1',
    'Második önálló use case konfiguráció egyedi alkalmazáskód nélkül (SC-01): fuvarozói engedélyek, tengelysúly, ADR veszélyes áru és vámokmányok ellenőrzése.',
    'Logistics & Customs Compliance',
    JSON.stringify(uc2Mapping),
    0,
    now,
    now
  );

  const shipmentsData = [
    { szallitmany_id: 'SHP-5001', fuvarozo_kod: 'TRANS-EU-01', celorszag: 'AT', brutto_tomeg_kg: 18500, adr_veszelyes: 'Nem', vam_okmany_szam: 'EU-INTRA' },
    { szallitmany_id: 'SHP-5002', fuvarozo_kod: 'TRANS-EU-02', celorszag: 'CH', brutto_tomeg_kg: 26400, adr_veszelyes: 'Nem', vam_okmany_szam: '' },
    { szallitmany_id: 'SHP-5003', fuvarozo_kod: 'TRANS-EU-01', celorszag: 'DE', brutto_tomeg_kg: 21000, adr_veszelyes: 'Igen', vam_okmany_szam: 'EU-INTRA' }
  ];
  const carriersData = [
    { fuvarozo_kod: 'TRANS-EU-01', fuvarozo_nev: 'Danube EuroTrans Kft.', max_engedelyezett_kg: 24000, adr_engedely: 'Van' },
    { fuvarozo_kod: 'TRANS-EU-02', fuvarozo_nev: 'Alpok Expressz Zrt.', max_engedelyezett_kg: 24000, adr_engedely: 'Nincs' }
  ];

  insertDs.run('DS-SHIPMENTS', uc2Id, 'Induló Szállítmányok (CSV)', 'excel_csv', 1, JSON.stringify({ fileName: 'shipments.csv' }), '[]', JSON.stringify(shipmentsData), computeDeterministicHash(shipmentsData), shipmentsData.length, now);
  insertDs.run('DS-CARRIERS', uc2Id, 'Fuvarozói Engedélytörzs (Referencia)', 'reference_data', 0, JSON.stringify({ tableCode: 'REF_CARRIERS' }), '[]', JSON.stringify(carriersData), computeDeterministicHash(carriersData), carriersData.length, now);

  const uc2Rules = [
    {
      id: 'S-001',
      name: 'Maximális össztömeg korlát (<= 24 000 kg)',
      description: 'A szerelvény hasznos tömege nem haladhatja meg a 24 000 kg-ot.',
      category: 'Súly- és Méretkorlát',
      ruleType: 'visual_condition',
      inputFields: ['brutto_tomeg_kg'],
      conditions: { combinator: 'AND', rules: [{ field: 'brutto_tomeg_kg', operator: '<=', value: 24000 }] },
      output: {
        outputField: 'tomeg_megfelelo',
        outputType: 'classification',
        trueValue: 'OK',
        falseValue: 'Túlsúly (>24t)',
        onTrueStatus: 'Accepted',
        onFalseStatus: 'Error',
        passMessage: 'Tömeg ({brutto_tomeg_kg} kg) határértéken belül.',
        failMessage: 'Túlsúlyos szállítmány ({brutto_tomeg_kg} kg > 24 000 kg)!'
      },
      dependencies: [],
      executionOrder: 1,
      lifecycleStatus: 'Prod',
      validationStatus: 'Passed',
      version: 1
    },
    {
      id: 'S-002',
      name: 'EU-n kívüli célország (CH) vámokmány ellenőrzése',
      description: 'Svájci (CH) kiszállításhoz vámokmány vagy felülvizsgálat szükséges.',
      category: 'Vám és ADR',
      ruleType: 'visual_condition',
      inputFields: ['celorszag', 'vam_okmany_szam'],
      conditions: {
        combinator: 'OR',
        rules: [
          { field: 'celorszag', operator: '!=', value: 'CH' },
          { field: 'vam_okmany_szam', operator: 'is_not_null' }
        ]
      },
      output: {
        outputField: 'vam_ellenorzes',
        outputType: 'classification',
        trueValue: 'OK',
        falseValue: 'Vámokmány hiányzik',
        onTrueStatus: 'Accepted',
        onFalseStatus: 'Requires Review',
        passMessage: 'Vámokmány rendben.',
        failMessage: 'EU-n kívüli célország (CH) hiányzó vámokmánnyal – felülvizsgálat szükséges!'
      },
      dependencies: ['S-001'],
      executionOrder: 2,
      lifecycleStatus: 'Prod',
      validationStatus: 'Passed',
      version: 1
    }
  ];

  for (const r of uc2Rules) {
    saveRuleToDb(db, uc2Id, r, 'Kovács Anna (Üzleti Szabálygazda)');
  }

  // Initial Audit Log entries
  logAudit(db, {
    useCaseId: uc1Id,
    eventType: 'SYSTEM_SEED',
    actor: 'Rendszer Adminisztrátor',
    entityType: 'USE_CASE',
    entityId: uc1Id,
    summary: 'Safe Rules v1.2 inicializálva: 4 adatforrás, 85 szabály (80 Prod, 2 Test, 2 Draft, 1 Retired), 6 teszteset és 105 rendelés kiértékelve.',
    details: { ruleCount: 85, prodRuleCount: 80, recordCount: 105 }
  });
}

if (require.main === module) {
  const db = initDatabase();
  const reset = process.argv.includes('--reset');
  seedDatabase(db, reset);
  console.log('Safe Rules database seeded successfully.');
}

module.exports = {
  seedDatabase,
  buildWindowOrderRecords,
  buildWindowValidationRules
};
