export const log = (event: string, data: Record<string, unknown> = {}) => {
  const safe = JSON.stringify({ at: new Date().toISOString(), event, ...data }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  console.log(safe);
};

export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
