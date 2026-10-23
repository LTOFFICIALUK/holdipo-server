import postgres from "postgres";
import { config } from "./config.js";

export type Db = postgres.Sql<{ bigint: bigint }>;
let client: Db | null = null;

export const sql = (): Db => {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required.");
  if (!client) {
    const local = /localhost|127\.0\.0\.1|railway\.internal/.test(config.databaseUrl);
    client = postgres(config.databaseUrl, {
      max: 8,
      ssl: local ? false : "require",
      types: { bigint: postgres.BigInt },
      onnotice: () => undefined,
    });
  }
  return client;
};

export const dbReady = async () => {
  try {
    await sql()`select 1`;
    return true;
  } catch {
    return false;
  }
};

// One worker at a time across instances. Returns false when another instance holds the lock.
export const withLock = async <T>(key: number, fn: () => Promise<T>): Promise<{ ran: boolean; value?: T }> => {
  const db = sql();
  const reserved = await db.reserve();
  try {
    const [row] = await reserved`select pg_try_advisory_lock(${key}) as ok`;
    if (!row?.ok) return { ran: false };
    try {
      return { ran: true, value: await fn() };
    } finally {
      await reserved`select pg_advisory_unlock(${key})`;
    }
  } finally {
    reserved.release();
  }
};

export const kvGet = async <T>(key: string, fallback: T): Promise<T> => {
  const [row] = await sql()`select value from kv where key = ${key}`;
  return row ? (row.value as T) : fallback;
};

export const kvSet = async (key: string, value: unknown) => {
  await sql()`
    insert into kv (key, value, updated_at) values (${key}, ${sql().json(value as postgres.JSONValue)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
};
