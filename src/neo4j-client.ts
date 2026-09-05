import { cypherIdentifier } from './types.js';
import neo4j, { Driver, Integer, Node, QueryResult, Record as Neo4jRecord, Relationship, Session } from 'neo4j-driver';

export interface Neo4jQueryParams {
  [key: string]: any;
}

export class Neo4jClient {
  private driver: Driver;
  private database?: string;

  constructor(uri: string, username: string, password: string, database?: string) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
    this.database = database;
  }

  private convertNestedIntegers(value: any): any {
    if (value instanceof Integer) {
      return value.toNumber();
    }

    if (value instanceof Node) {
      return {
        ...this.convertNestedIntegers(value.properties),
        _id: value.identity.toNumber(),
        _labels: value.labels,
      };
    }

    if (value instanceof Relationship) {
      return {
        ...this.convertNestedIntegers(value.properties),
        _id: value.identity.toNumber(),
        _type: value.type,
      };
    }

    if (neo4j.isPath(value)) {
      return {
        start: this.convertNestedIntegers(value.start),
        end: this.convertNestedIntegers(value.end),
        segments: value.segments.map((segment) => ({
          start: this.convertNestedIntegers(segment.start),
          relationship: this.convertNestedIntegers(segment.relationship),
          end: this.convertNestedIntegers(segment.end),
        })),
      };
    }

    if (neo4j.isPoint(value)) {
      return { srid: this.convertNestedIntegers(value.srid), x: value.x, y: value.y, z: value.z };
    }

    if (
      neo4j.isDate(value) || neo4j.isDateTime(value) || neo4j.isLocalDateTime(value) ||
      neo4j.isTime(value) || neo4j.isLocalTime(value) || neo4j.isDuration(value)
    ) {
      return value.toString();
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.convertNestedIntegers(item));
    }

    if (value && typeof value === 'object' && value.constructor === Object) {
      const converted: { [key: string]: any } = {};
      for (const [key, val] of Object.entries(value)) {
        converted[key] = this.convertNestedIntegers(val);
      }
      return converted;
    }

    return value;
  }

  private recordToObject<T>(record: Neo4jRecord): T {
    const obj: { [key: string]: any } = {};
    for (const key of record.keys) {
      obj[key as string] = this.convertNestedIntegers(record.get(key));
    }
    return obj as T;
  }

  async executeQuery<T = any>(query: string, params: Neo4jQueryParams = {}): Promise<T[]> {
    const session: Session = this.driver.session({
      database: this.database
    });
    try {
      const result: QueryResult = await session.run(query, params);
      return result.records.map((record: Neo4jRecord) => this.recordToObject<T>(record));
    } finally {
      await session.close();
    }
  }

  /**
   * Caller-supplied Cypher: runs in a READ transaction (the server rejects writes), stops
   * consuming after `limit` records instead of materialising the whole result, and is
   * bounded by a transaction timeout.
   */
  async executeReadQuery<T = any>(
    query: string,
    params: Neo4jQueryParams,
    options: { limit: number; timeoutMs: number }
  ): Promise<T[]> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 0) {
      throw new Error('Query limit must be a non-negative integer');
    }
    if (options.limit === 0) {
      return [];
    }
    const session: Session = this.driver.session({
      database: this.database,
      defaultAccessMode: neo4j.session.READ
    });
    try {
      return await session.executeRead(async (tx) => {
        const rows: T[] = [];
        for await (const record of tx.run(query, params)) {
          rows.push(this.recordToObject<T>(record));
          if (rows.length >= options.limit) {
            break;
          }
        }
        return rows;
      }, { timeout: options.timeoutMs });
    } finally {
      await session.close();
    }
  }

  async getNodes(label: string): Promise<any[]> {
    return this.executeQuery(`MATCH (n:${cypherIdentifier(label)}) RETURN n as memory`);
  }

  async createNode(label: string, properties: Neo4jQueryParams): Promise<any> {
    const result = await this.executeQuery(`CREATE (n:${cypherIdentifier(label)} $props) RETURN n as memory`, { props: properties });
    return result[0];
  }

  async createRelationship(fromNodeId: number, toNodeId: number, relationType: string, properties: Neo4jQueryParams = {}): Promise<any> {
    const result = await this.executeQuery(
      `MATCH (a), (b)
       WHERE id(a) = $fromId AND id(b) = $toId
       CREATE (a)-[r:${cypherIdentifier(relationType)} $props]->(b)
       RETURN r as relationship`,
      {
        fromId: neo4j.int(fromNodeId),
        toId: neo4j.int(toNodeId),
        props: properties,
      }
    );
    return result[0];
  }

  async updateNode(nodeId: number, properties: Neo4jQueryParams): Promise<any> {
    const result = await this.executeQuery(
      `MATCH (n) WHERE id(n) = $nodeId
       SET n += $props
       RETURN n as memory`,
      {
        nodeId: neo4j.int(nodeId),
        props: properties,
      }
    );
    return result[0];
  }

  async updateRelationship(fromNodeId: number, toNodeId: number, relationType: string, properties: Neo4jQueryParams): Promise<any> {
    const result = await this.executeQuery(
      `MATCH (a)-[r:${cypherIdentifier(relationType)}]->(b)
       WHERE id(a) = $fromId AND id(b) = $toId
       SET r += $props
       RETURN r as relationship`,
      {
        fromId: neo4j.int(fromNodeId),
        toId: neo4j.int(toNodeId),
        props: properties,
      }
    );
    return result[0];
  }

  async deleteNode(nodeId: number): Promise<any> {
    const result = await this.executeQuery(
      `MATCH (n) WHERE id(n) = $nodeId
       DETACH DELETE n
       RETURN count(n) as deletedCount`,
      {
        nodeId: neo4j.int(nodeId),
      }
    );
    return result[0];
  }

  async deleteRelationship(fromNodeId: number, toNodeId: number, relationType: string): Promise<any> {
    const result = await this.executeQuery(
      `MATCH (a)-[r:${cypherIdentifier(relationType)}]->(b)
       WHERE id(a) = $fromId AND id(b) = $toId
       DELETE r
       RETURN count(r) as deletedCount`,
      {
        fromId: neo4j.int(fromNodeId),
        toId: neo4j.int(toNodeId),
      }
    );
    return result[0];
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
