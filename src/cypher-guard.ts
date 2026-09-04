/** Read-only guard for caller-supplied Cypher. Defence in depth: the query also runs in a READ transaction. */

const WRITE_CLAUSE_RE = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|DETACH|FOREACH|LOAD\s+CSV)\b/i;
const CALL_RE = /\bCALL\b\s*(\{|([A-Za-z_][\w.]*))/gi;

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

/** Returns why the Cypher is not read-only, or null when it passes the guard. */
export function readOnlyViolation(cypher: string): string | null {
  const writeClause = cypher.match(WRITE_CLAUSE_RE);
  if (writeClause) {
    return `${writeClause[1].toUpperCase()} is not allowed`;
  }

  for (const match of cypher.matchAll(CALL_RE)) {
    if (match[1] === '{') {
      return 'CALL subqueries are not allowed';
    }
    const procedure = match[2].toLowerCase();
    if (!READ_ONLY_PROCEDURES.has(procedure)) {
      return `procedure ${match[2]} is not on the read-only allow-list`;
    }
  }

  return null;
}
