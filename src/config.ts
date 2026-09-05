import { Neo4jServerConfig } from './types.js';

function isSet(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Neo4j connection from NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD (+ optional NEO4J_DATABASE); undefined when unset. */
export function neo4jConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Neo4jServerConfig | undefined {
  const uri = env.NEO4J_URI?.trim();
  const username = env.NEO4J_USERNAME?.trim();
  const password = env.NEO4J_PASSWORD; // never trimmed: whitespace can be part of a password
  if (!uri || !username || !isSet(password)) {
    return undefined;
  }
  return {
    uri,
    username,
    password,
    database: env.NEO4J_DATABASE?.trim() || undefined // optional for Neo4j Community Edition
  };
}

/** A partial configuration is a mistake worth refusing to start on; returns the message to print, or null. */
export function neo4jConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const uri = env.NEO4J_URI?.trim();
  const username = env.NEO4J_USERNAME?.trim();
  const password = isSet(env.NEO4J_PASSWORD);
  if (!(uri || username || password) || (uri && username && password)) {
    return null;
  }
  if (!password) return 'Error: NEO4J_PASSWORD environment variable is required';
  if (!uri) return 'Error: NEO4J_URI environment variable is required';
  return 'Error: NEO4J_USERNAME environment variable is required';
}
