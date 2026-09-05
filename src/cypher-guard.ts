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

/**
 * Reduce Cypher to the text the guard should look at: comments become spaces, and the contents of
 * string literals and backtick-quoted identifiers are blanked so a `//` or a keyword inside a
 * string can neither hide code nor trigger a false positive. A small stateful scan, not a regex,
 * because a `//` inside a quoted URL must not be treated as a comment.
 */
export function stripComments(cypher: string): string {
  let out = '';
  let i = 0;
  const n = cypher.length;
  while (i < n) {
    const ch = cypher[i];
    const next = cypher[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && cypher[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = cypher.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += quote;
      i++;
      while (i < n) {
        const c = cypher[i];
        if (c === '\\' && quote !== '`') { i += 2; continue; }      // escaped char inside a string
        if (c === quote) {
          if (cypher[i + 1] === quote) { i += 2; continue; }         // doubled quote
          break;
        }
        i++;
      }
      out += quote;                                                   // literal contents dropped
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
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
