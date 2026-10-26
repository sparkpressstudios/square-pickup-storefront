export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, parameters?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<unknown>;
}
export interface SqlDatabase extends SqlExecutor {
  transaction<T>(callback: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
