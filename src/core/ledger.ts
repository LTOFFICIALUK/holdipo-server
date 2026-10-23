import { sql } from "./db.js";

const bump = async (key: string, delta: bigint) => {
  await sql()`
    insert into kv (key, value) values (${key}, ${sql().json(delta.toString())})
    on conflict (key) do update set value = to_jsonb(((kv.value #>> '{}')::numeric + ${delta.toString()}::numeric)::text), updated_at = now()
  `;
};

export const readCounter = async (key: string) => {
  const [row] = await sql()`select value #>> '{}' as v from kv where key = ${key}`;
  return row?.v ? BigInt(row.v as string) : 0n;
};

export const addCost = async (kind: string, lamports: bigint, signature: string | null) => {
  if (lamports <= 0n) return;
  await sql()`insert into costs (kind, lamports, signature) values (${kind}, ${lamports}, ${signature})`;
  await bump("unrecovered_costs", lamports);
};

export const bumpCounter = bump;

// What the treasury must still hold for holders: unpaid shares plus payouts
// booked but not yet out of the treasury. Routed payouts whose deposit landed
// have already left, so they are not counted.
export const liabilities = async () => {
  const [owed] = await sql()`select coalesce(sum(owed_lamports), 0)::text as v from accounts`;
  const [inflight] = await sql()`
    select coalesce(sum(lamports), 0)::text as v from payouts where status in ('planned', 'sent')
  `;
  return BigInt(owed.v as string) + BigInt(inflight.v as string);
};

export const totals = async () => {
  const [row] = await sql()`
    select
      (select count(*) from splits where source_lamports > 0 or allocated_lamports > 0)::int as splits,
      (select coalesce(sum(allocated_lamports), 0)::text from splits) as allocated,
      (select coalesce(sum(lamports), 0)::text from payouts where status = 'confirmed') as paid,
      (select count(distinct wallet) from payouts where status = 'confirmed')::int as paid_wallets,
      (select coalesce(sum(lamports), 0)::text from inflows where status = 'moved') as inflow,
      (select coalesce(sum(lamports), 0)::text from costs) as costs
  `;
  return {
    splits: Number(row.splits),
    allocatedLamports: String(row.allocated),
    paidLamports: String(row.paid),
    paidWallets: Number(row.paid_wallets),
    inflowLamports: String(row.inflow),
    costLamports: String(row.costs),
  };
};
