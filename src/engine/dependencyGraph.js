'use strict';

const { extractReferencedFields } = require('./ruleModel');

/**
 * Builds the complete dependency graph for a set of rules.
 * Automatically discovers implicit dependencies when Rule B reads an outputField produced by Rule A,
 * and merges them with explicit rule.dependencies.
 */
function buildDependencyGraph(rules) {
  const ruleMap = new Map();
  const outputFieldProducerMap = new Map();

  for (const r of rules) {
    ruleMap.set(r.id, r);
    const outField = (r.output && r.output.outputField) || r.outputField;
    if (outField) {
      outputFieldProducerMap.set(outField, r.id);
    }
  }

  const dependenciesOf = new Map(); // ruleId -> Set of upstream ruleIds it depends on
  const dependentsOf = new Map();   // ruleId -> Set of downstream ruleIds that depend on it
  const dependencyReasons = [];     // { from: upstreamId, to: downstreamId, viaField, type: 'implicit'|'explicit' }

  for (const r of rules) {
    dependenciesOf.set(r.id, new Set());
    dependentsOf.set(r.id, new Set());
  }

  for (const r of rules) {
    const explicitDeps = Array.isArray(r.dependencies) ? r.dependencies : [];
    const referencedFields = extractReferencedFields(r);

    // 1. Explicit dependencies
    for (const depId of explicitDeps) {
      if (ruleMap.has(depId) && depId !== r.id) {
        dependenciesOf.get(r.id).add(depId);
        dependentsOf.get(depId).add(r.id);
        const producerOut = (ruleMap.get(depId).output && ruleMap.get(depId).output.outputField) || ruleMap.get(depId).outputField;
        dependencyReasons.push({
          from: depId,
          to: r.id,
          viaField: producerOut || 'explicit',
          type: 'explicit'
        });
      } else if (depId === r.id) {
        // Self-dependency is a cycle of length 1
        dependenciesOf.get(r.id).add(depId);
        dependentsOf.get(depId).add(r.id);
      }
    }

    // 2. Implicit dependencies via outputField -> inputField matching
    for (const field of referencedFields) {
      const producerId = outputFieldProducerMap.get(field);
      if (producerId && producerId !== r.id) {
        if (!dependenciesOf.get(r.id).has(producerId)) {
          dependenciesOf.get(r.id).add(producerId);
          dependentsOf.get(producerId).add(r.id);
          dependencyReasons.push({
            from: producerId,
            to: r.id,
            viaField: field,
            type: 'implicit'
          });
        }
      }
    }
  }

  return {
    ruleMap,
    outputFieldProducerMap,
    dependenciesOf,
    dependentsOf,
    edges: dependencyReasons
  };
}

/**
 * Detects any circular dependencies in the rule graph using DFS coloring.
 * Returns { hasCycle: boolean, cycles: Array<Array<string>>, message: string|null }
 */
function detectCycles(rules) {
  const { dependenciesOf } = buildDependencyGraph(rules);
  const WHITE = 0; // unvisited
  const GRAY = 1;  // visiting in current recursion stack
  const BLACK = 2; // completely visited

  const color = new Map();
  const parent = new Map();
  const cycles = [];

  for (const r of rules) {
    color.set(r.id, WHITE);
  }

  function dfs(u, stack) {
    color.set(u, GRAY);
    stack.push(u);

    const deps = dependenciesOf.get(u) || new Set();
    for (const v of deps) {
      if (!color.has(v)) continue;
      if (color.get(v) === GRAY) {
        const cycleStartIdx = stack.indexOf(v);
        const cyclePath = [...stack.slice(cycleStartIdx), v];
        cycles.push(cyclePath);
      } else if (color.get(v) === WHITE) {
        parent.set(v, u);
        dfs(v, stack);
      }
    }

    stack.pop();
    color.set(u, BLACK);
  }

  for (const r of rules) {
    if (color.get(r.id) === WHITE) {
      dfs(r.id, []);
    }
  }

  if (cycles.length > 0) {
    const formatted = cycles.map(c => c.join(' → ')).join('; ');
    return {
      hasCycle: true,
      cycles,
      message: `Körkörös függőség észlelve (tiltott állapot): ${formatted}`
    };
  }

  return {
    hasCycle: false,
    cycles: [],
    message: null
  };
}

/**
 * Computes deterministic topological execution order using Kahn's algorithm,
 * respecting user's executionOrder as priority tie-breaker where dependencies permit,
 * and computing depth levels (Layer 0, 1, 2...) for visualization.
 */
function computeRecommendedOrder(rules) {
  const cycleCheck = detectCycles(rules);
  if (cycleCheck.hasCycle) {
    return {
      valid: false,
      hasCycle: true,
      cycles: cycleCheck.cycles,
      message: cycleCheck.message,
      orderedRules: [],
      levels: {}
    };
  }

  const { ruleMap, dependenciesOf, dependentsOf, edges } = buildDependencyGraph(rules);
  const inDegree = new Map();
  const levelMap = new Map();

  for (const r of rules) {
    const deps = dependenciesOf.get(r.id) || new Set();
    inDegree.set(r.id, deps.size);
    levelMap.set(r.id, 0);
  }

  // Available queue sorted deterministically by (executionOrder, id)
  const available = rules
    .filter(r => inDegree.get(r.id) === 0)
    .map(r => r.id);

  const sortQueue = (queue) => {
    queue.sort((aId, bId) => {
      const a = ruleMap.get(aId);
      const b = ruleMap.get(bId);
      const ordA = Number.isFinite(Number(a.executionOrder)) ? Number(a.executionOrder) : 999999;
      const ordB = Number.isFinite(Number(b.executionOrder)) ? Number(b.executionOrder) : 999999;
      if (ordA !== ordB) return ordA - ordB;
      return String(aId).localeCompare(String(bId));
    });
  };

  sortQueue(available);
  const orderedIds = [];

  while (available.length > 0) {
    const currentId = available.shift();
    orderedIds.push(currentId);
    const currentLevel = levelMap.get(currentId) || 0;

    const downstream = dependentsOf.get(currentId) || new Set();
    for (const nextId of downstream) {
      levelMap.set(nextId, Math.max(levelMap.get(nextId) || 0, currentLevel + 1));
      inDegree.set(nextId, inDegree.get(nextId) - 1);
      if (inDegree.get(nextId) === 0) {
        available.push(nextId);
        sortQueue(available);
      }
    }
  }

  const levels = {};
  const orderedRules = orderedIds.map((id, idx) => {
    const r = ruleMap.get(id);
    const depth = levelMap.get(id) || 0;
    levels[id] = depth;
    return {
      ...r,
      dependencies: Array.from(dependenciesOf.get(id) || []),
      dependents: Array.from(dependentsOf.get(id) || []),
      recommendedOrder: idx + 1,
      depthLevel: depth
    };
  });

  return {
    valid: true,
    hasCycle: false,
    cycles: [],
    message: null,
    orderedRules,
    orderedIds,
    levels,
    edges
  };
}

/**
 * Validates a manual execution order override proposed by the user.
 * Specification Section 9 & SC-04: "A felhasználó felülbírálhatja, de a kötelező függőségek nem sérülhetnek."
 */
function validateExecutionOrder(rules, proposedOrderIds) {
  const cycleCheck = detectCycles(rules);
  if (cycleCheck.hasCycle) {
    return {
      valid: false,
      violations: [{ type: 'CYCLE', message: cycleCheck.message }],
      message: cycleCheck.message
    };
  }

  const { ruleMap, dependenciesOf } = buildDependencyGraph(rules);
  const positionMap = new Map();
  proposedOrderIds.forEach((id, idx) => {
    positionMap.set(id, idx);
  });

  // Ensure all rules have a position
  rules.forEach((r, idx) => {
    if (!positionMap.has(r.id)) {
      positionMap.set(r.id, proposedOrderIds.length + idx);
    }
  });

  const violations = [];
  for (const r of rules) {
    const myPos = positionMap.get(r.id);
    const deps = dependenciesOf.get(r.id) || new Set();
    for (const depId of deps) {
      if (!positionMap.has(depId)) continue;
      const depPos = positionMap.get(depId);
      if (depPos >= myPos) {
        const depRule = ruleMap.get(depId);
        violations.push({
          ruleId: r.id,
          ruleName: r.name,
          dependsOnRuleId: depId,
          dependsOnRuleName: depRule ? depRule.name : depId,
          rulePosition: myPos + 1,
          dependencyPosition: depPos + 1,
          message: `Kötelező függőség sérülése: A(z) '${r.id} (${r.name})' szabály (#${myPos + 1}) nem hajtható végre a(z) '${depId} (${depRule ? depRule.name : depId})' szabály (#${depPos + 1}) előtt!`
        });
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    message: violations.length > 0 ? violations[0].message : 'A végrehajtási sorrend érvényes, minden függőség teljesül.'
  };
}

/**
 * Performs impact analysis when a rule is modified or inspected.
 * Returns direct dependents, all transitive dependents, and affected Prod/Test rules requiring re-validation.
 */
function analyzeDownstreamImpact(rules, targetRuleId) {
  const { ruleMap, dependentsOf, edges } = buildDependencyGraph(rules);
  if (!ruleMap.has(targetRuleId)) {
    return {
      targetRuleId,
      directDependents: [],
      allAffectedRuleIds: [],
      affectedRules: [],
      requiresRetestRuleIds: []
    };
  }

  const directSet = dependentsOf.get(targetRuleId) || new Set();
  const visited = new Set();
  const queue = Array.from(directSet).map(id => ({ id, distance: 1, path: [targetRuleId, id] }));
  const affectedDetails = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current.id)) continue;
    visited.add(current.id);

    const r = ruleMap.get(current.id);
    if (r) {
      affectedDetails.push({
        id: r.id,
        name: r.name,
        category: r.category,
        lifecycleStatus: r.lifecycleStatus,
        validationStatus: r.validationStatus,
        distance: current.distance,
        impactPath: current.path.join(' → ')
      });
    }

    const nextDeps = dependentsOf.get(current.id) || new Set();
    for (const nextId of nextDeps) {
      if (!visited.has(nextId)) {
        queue.push({
          id: nextId,
          distance: current.distance + 1,
          path: [...current.path, nextId]
        });
      }
    }
  }

  return {
    targetRuleId,
    directDependents: Array.from(directSet),
    allAffectedRuleIds: Array.from(visited),
    affectedRules: affectedDetails,
    requiresRetestRuleIds: [targetRuleId, ...Array.from(visited)],
    relevantEdges: edges.filter(e => e.from === targetRuleId || visited.has(e.from) || visited.has(e.to))
  };
}

module.exports = {
  buildDependencyGraph,
  detectCycles,
  computeRecommendedOrder,
  validateExecutionOrder,
  analyzeDownstreamImpact
};
