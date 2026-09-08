// Node 22's built-in SQLite API; the project still uses Node 20 ambient types.
declare module 'node:sqlite' {
  type Value = string | number | bigint | Uint8Array | null;
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {run(...values: Value[]): {changes:number|bigint;lastInsertRowid:number|bigint};get(...values:Value[]):Record<string,Value>|undefined;all(...values:Value[]):Record<string,Value>[]};
    close(): void;
  }
}
