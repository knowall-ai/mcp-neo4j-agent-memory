/** Read-only guard for caller-supplied Cypher. Defence in depth: the query also runs in a READ transaction. */

const WRITE_CLAUSE_RE = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|DETACH|FOREACH|LOAD\s+CSV)\b/i;
const CALL_TOKEN_RE = /\bCALL\b/gi;
const PROCEDURE_RE = /^\s*([A-Za-z_][\w.]*)/;

/** Built-in procedures that only read. Anything else (APOC, db.create.*, dbms.*) is rejected. */
export const READ_ONLY_PROCEDURES = new Set<string>([
  'db.labels',
  'db.relationshiptypes',
  'db.propertykeys',
  'db.schema.visualization',
  'db.schema.nodetypeproperties',
  'db.schema.reltypeproperties',
  'db.index.vector.querynodes',
  'db.index.vector.queryrelationships',
  'db.index.fulltext.querynodes',
  'db.index.fulltext.queryrelationships'
]);

/** Remove line and block comments so nothing can hide between a keyword and what follows it. */
export function stripComments(cypher: string): string {
  return cypher.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Returns why the Cypher is not read-only, or null when it passes the guard. */
export function readOnlyViolation(rawCypher: string): string | null {
  const cypher = stripComments(rawCypher);

  const writeClause = cypher.match(WRITE_CLAUSE_RE);
  if (writeClause) {
    return `${writeClause[1].toUpperCase()} is not allowed`;
  }

  for (const match of cypher.matchAll(CALL_TOKEN_RE)) {
    const rest = cypher.slice(match.index! + match[0].length);
    if (/^\s*\{/.test(rest)) {
      return 'CALL subqueries are not allowed';
    }
    const procedure = rest.match(PROCEDURE_RE);
    if (!procedure) {
      return 'CALL could not be resolved to a procedure';
    }
    if (!READ_ONLY_PROCEDURES.has(procedure[1].toLowerCase())) {
      return `procedure ${procedure[1]} is not on the read-only allow-list`;
    }
  }

  return null;
}
