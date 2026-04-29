// sql.js ships JS but no .d.ts — ambient module declaration
declare module 'sql.js' {
  export interface Database {
    run(sql: string, params?: unknown[]): Database
    exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[]
    prepare(sql: string): Statement
    close(): void
    getRowsModified(): number
    export(): Uint8Array
  }
  export interface Statement {
    bind(params?: unknown[]): boolean
    step(): boolean
    getAsObject(params?: Record<string, unknown>): Record<string, unknown>
    get(params?: unknown[]): unknown[]
    free(): boolean
    reset(): void
    run(params?: unknown[]): void
  }
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database
  }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>
}
