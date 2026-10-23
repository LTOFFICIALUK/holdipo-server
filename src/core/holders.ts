import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { rpc } from "./chain.js";

export type Holding = { wallet: string; amount: bigint };

type Filter = { memcmp: { offset: number; bytes: string } } | { dataSize: number };

const decode = (data: Buffer, out: Map<string, bigint>) => {
  if (data.length < 40) return;
  const amount = data.readBigUInt64LE(32);
  if (amount === 0n) return;
  const wallet = new PublicKey(data.subarray(0, 32)).toBase58();
  out.set(wallet, (out.get(wallet) ?? 0n) + amount);
};

// Helius pages large token programs through getProgramAccountsV2.
const pagedV2 = async (programId: PublicKey, filters: Filter[], out: Map<string, bigint>) => {
  let paginationKey: string | null = null;
  for (let page = 0; page < 500; page += 1) {
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getProgramAccountsV2",
        params: [
          programId.toBase58(),
          { encoding: "base64", commitment: "confirmed", filters, dataSlice: { offset: 32, length: 40 }, limit: 10_000, ...(paginationKey ? { paginationKey } : {}) },
        ],
      }),
    });
    const body = (await res.json()) as {
      error?: { message?: string };
      result?: { accounts: { account: { data: [string, string] } }[]; paginationKey: string | null };
    };
    if (body.error || !body.result) throw new Error(body.error?.message || "getProgramAccountsV2 failed");
    for (const a of body.result.accounts) decode(Buffer.from(a.account.data[0], "base64"), out);
    paginationKey = body.result.paginationKey;
    if (!paginationKey) return;
  }
  throw new Error("Too many holder pages.");
};

const readProgram = async (programId: PublicKey, mint: PublicKey, out: Map<string, bigint>) => {
  const filters: Filter[] = [{ memcmp: { offset: 0, bytes: mint.toBase58() } }];
  // Legacy token accounts are always 165 bytes; Token-2022 ones vary with extensions.
  if (programId.equals(TOKEN_PROGRAM_ID)) filters.push({ dataSize: 165 });
  try {
    const accounts = await rpc().getProgramAccounts(programId, {
      commitment: "confirmed",
      filters,
      dataSlice: { offset: 32, length: 40 },
    });
    for (const a of accounts) decode(a.account.data, out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/getProgramAccountsV2|Too many accounts|large/i.test(msg)) throw err;
    out.clear();
    await pagedV2(programId, filters, out);
  }
};

// Every token account for the mint, summed by owner. Reads only the program
// that owns the mint.
export const snapshotHolders = async (mint: PublicKey) => {
  const [info, supply] = await Promise.all([rpc().getAccountInfo(mint, "confirmed"), rpc().getTokenSupply(mint, "confirmed")]);
  if (!info) throw new Error("Mint not found.");
  const holdings = new Map<string, bigint>();
  await readProgram(info.owner, mint, holdings);
  return { holdings, decimals: supply.value.decimals, supply: BigInt(supply.value.amount) };
};

export const walletTokenBalance = async (owner: PublicKey, mint: PublicKey) => {
  let total = 0n;
  const res = await rpc().getTokenAccountsByOwner(owner, { mint }, "confirmed");
  for (const acc of res.value) total += acc.account.data.readBigUInt64LE(64);
  return total;
};

