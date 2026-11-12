'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

let dbInstance = null;

function getDbPath() {
  if (process.env.SAFE_RULES_DB_PATH) {
    return process.env.SAFE_RULES_DB_PATH;
  }
  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, 'safe_rules.sqlite');
}

function initDatabase(customPath) {
  if (dbInstance && !customPath) {
    return dbInstance;
  }
  const targetPath = customPath || getDbPath();
  const db = new DatabaseSync(targetPath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS use_cases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      description TEXT,
      category TEXT,
      mapping_config_json TEXT NOT NULL,
      is_active INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS data_sources (
      id TEXT NOT NULL,
      use_case_id TEXT NOT NULL,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0,
      connection_config_json TEXT,
      schema_fields_json TEXT,
      records_json TEXT NOT NULL,
      sha256_checksum TEXT NOT NULL,
      record_count INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (use_case_id, id)
    );

    CREATE TABLE IF NOT EXISTS rules (
      id TEXT NOT NULL,
      use_case_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      rule_type TEXT NOT NULL,
      input_fields_json TEXT,
      conditions_json TEXT,
      decision_table_json TEXT,
      expression_text TEXT,
      output_json TEXT NOT NULL,
      dependencies_json TEXT,
      execution_order INTEGER DEFAULT 1,
      lifecycle_status TEXT NOT NULL DEFAULT 'Draft',
      validation_status TEXT NOT NULL DEFAULT 'Untested',
      version INTEGER NOT NULL DEFAULT 1,
      approved_by TEXT,
      approved_at TEXT,
      approval_note TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (use_case_id, id)
    );

    CREATE TABLE IF NOT EXISTS rule_versions (
      version_id INTEGER PRIMARY KEY AUTOINCREMENT,
      use_case_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      lifecycle_status TEXT NOT NULL,
      rule_snapshot_json TEXT NOT NULL,
      approved_by TEXT,
      approval_note TEXT,
      archived_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS test_cases (
      id TEXT NOT NULL,
      use_case_id TEXT NOT NULL,
      test_code TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      description TEXT,
      target_rule_id TEXT,
      input_data_json TEXT NOT NULL,
      expected_status TEXT NOT NULL,
      expected_outputs_json TEXT,
      user_confirmed INTEGER DEFAULT 1,
      last_run_actual_status TEXT,
      last_run_actual_outputs_json TEXT,
      last_run_passed INTEGER,
      last_run_trace_json TEXT,
      last_run_at TEXT,
      approved_by TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (use_case_id, id)
    );

    CREATE TABLE IF NOT EXISTS execution_runs (
      run_id TEXT PRIMARY KEY,
      use_case_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      executed_by TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      executed_rule_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      source_hash_before TEXT NOT NULL,
      source_hash_after TEXT NOT NULL,
      source_unchanged INTEGER NOT NULL,
      deterministic_output_hash TEXT NOT NULL,
      rule_versions_snapshot_json TEXT NOT NULL,
      status_counts_json TEXT NOT NULL,
      pipeline_steps_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS record_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      use_case_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      source_data_json TEXT NOT NULL,
      joined_data_json TEXT NOT NULL,
      enriched_data_json TEXT NOT NULL,
      final_status TEXT NOT NULL,
      requires_human_review INTEGER NOT NULL,
      status_reason TEXT,
      deviations_json TEXT NOT NULL,
      rule_traces_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS human_reviews (
      review_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      use_case_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      original_rule_status TEXT NOT NULL,
      decision TEXT NOT NULL,
      comment TEXT NOT NULL,
      reviewed_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      use_case_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS external_sql_catalog (
      sku_code TEXT PRIMARY KEY,
      product_family TEXT NOT NULL,
      material_grade TEXT NOT NULL,
      min_width_mm INTEGER NOT NULL,
      max_width_mm INTEGER NOT NULL,
      min_height_mm INTEGER NOT NULL,
      max_height_mm INTEGER NOT NULL,
      max_area_m2 REAL NOT NULL,
      min_frame_depth_mm INTEGER NOT NULL,
      standard_lead_days INTEGER NOT NULL,
      active_in_factory INTEGER NOT NULL
    );
  `);

  if (!customPath) {
    dbInstance = db;
  }
  return db;
}

function logAudit(db, { useCaseId, eventType, actor = 'Üzleti Elemző (Kovács Anna)', entityType, entityId, summary, details = {} }) {
  const stmt = db.prepare(`
    INSERT INTO audit_logs (use_case_id, event_type, actor, entity_type, entity_id, summary, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    useCaseId || 'GLOBAL',
    eventType,
    actor,
    entityType,
    String(entityId),
    summary,
    JSON.stringify(details),
    new Date().toISOString()
  );
}

function serializeRuleRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    useCaseId: row.use_case_id,
    name: row.name,
    description: row.description,
    category: row.category,
    ruleType: row.rule_type,
    inputFields: JSON.parse(row.input_fields_json || '[]'),
    conditions: row.conditions_json ? JSON.parse(row.conditions_json) : null,
    decisionTable: row.decision_table_json ? JSON.parse(row.decision_table_json) : null,
    expression: row.expression_text || null,
    output: JSON.parse(row.output_json || '{}'),
    dependencies: JSON.parse(row.dependencies_json || '[]'),
    executionOrder: row.execution_order,
    lifecycleStatus: row.lifecycle_status,
    validationStatus: row.validation_status,
    version: row.version,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    approvalNote: row.approval_note,
    updatedAt: row.updated_at
  };
}

function saveRuleToDb(db, useCaseId, rule, actor = 'Üzleti Elemző (Kovács Anna)') {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO rules (
      id, use_case_id, name, description, category, rule_type,
      input_fields_json, conditions_json, decision_table_json, expression_text,
      output_json, dependencies_json, execution_order,
      lifecycle_status, validation_status, version,
      approved_by, approved_at, approval_note, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(use_case_id, id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      category = excluded.category,
      rule_type = excluded.rule_type,
      input_fields_json = excluded.input_fields_json,
      conditions_json = excluded.conditions_json,
      decision_table_json = excluded.decision_table_json,
      expression_text = excluded.expression_text,
      output_json = excluded.output_json,
      dependencies_json = excluded.dependencies_json,
      execution_order = excluded.execution_order,
      lifecycle_status = excluded.lifecycle_status,
      validation_status = excluded.validation_status,
      version = excluded.version,
      approved_by = excluded.approved_by,
      approved_at = excluded.approved_at,
      approval_note = excluded.approval_note,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    rule.id,
    useCaseId,
    rule.name,
    rule.description || '',
    rule.category || 'Általános',
    rule.ruleType || 'visual_condition',
    JSON.stringify(rule.inputFields || []),
    rule.conditions ? JSON.stringify(rule.conditions) : null,
    rule.decisionTable ? JSON.stringify(rule.decisionTable) : null,
    rule.expression || null,
    JSON.stringify(rule.output || {}),
    JSON.stringify(rule.dependencies || []),
    Number(rule.executionOrder || 1),
    rule.lifecycleStatus || 'Draft',
    rule.validationStatus || 'Untested',
    Number(rule.version || 1),
    rule.approvedBy || null,
    rule.approvedAt || null,
    rule.approvalNote || null,
    rule.updatedAt || now
  );

  // If rule is Prod, preserve snapshot in rule_versions (Specification Section 9.1)
  if (rule.lifecycleStatus === 'Prod') {
    const archiveStmt = db.prepare(`
      INSERT INTO rule_versions (use_case_id, rule_id, version, lifecycle_status, rule_snapshot_json, approved_by, approval_note, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    archiveStmt.run(
      useCaseId,
      rule.id,
      Number(rule.version || 1),
      'Prod',
      JSON.stringify(rule),
      rule.approvedBy || actor,
      rule.approvalNote || 'Élesített szabályverzió',
      now
    );
  }
}

module.exports = {
  initDatabase,
  getDbPath,
  logAudit,
  serializeRuleRow,
  saveRuleToDb
};
