import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { config } from "./config.js";
import { rpc } from "./chain.js";
import { jupHeaders } from "./price.js";

export type Quote = {
  inAmount: bigint;
  outAmount: bigint;
  minOut: bigint;
  priceImpactPct: number;
  raw: Record<string, unknown>;
};

const swapBase = () => `${config.jupiterBase}/swap/v1`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const jfetch = async (url: string, init?: RequestInit) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(url, { ...init, headers: { ...jupHeaders(), "content-type": "application/json", ...(init?.headers || {}) } });
    if (res.status === 429) {
      await sleep(600 * (attempt + 1));
      continue;
    }
    return res;
  }
  throw new Error("Jupiter is busy. Try again in a moment.");
};

export const quote = async (input: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<Quote> => {
  const url = new URL(`${swapBase()}/quote`);
  url.searchParams.set("inputMint", input.inputMint);
  url.searchParams.set("outputMint", input.outputMint);
  url.searchParams.set("amount", input.amount.toString());
  url.searchParams.set("slippageBps", String(input.slippageBps));
  url.searchParams.set("restrictIntermediateTokens", "true");
  const res = await jfetch(url.toString());
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.outAmount !== "string") {
    const msg = typeof body.error === "string" ? body.error : "No route for this trade right now.";
    throw new Error(msg.includes("not tradable") || msg.includes("No routes") ? "No route for this coin right now." : msg);
  }
  return {
    inAmount: BigInt(body.inAmount as string),
    outAmount: BigInt(body.outAmount as string),
    minOut: BigInt(body.otherAmountThreshold as string),
    priceImpactPct: Math.abs(Number(body.priceImpactPct ?? 0)) * 100,
    raw: body,
  };
};

type RawIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };

const toIx = (ix: RawIx) =>
  new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });

const lookupTables = async (addresses: string[]) => {
  if (!addresses.length) return [];
  const infos = await rpc().getMultipleAccountsInfo(addresses.map((a) => new PublicKey(a)));
  return infos
    .map((info, i) =>
      info ? new AddressLookupTableAccount({ key: new PublicKey(addresses[i]), state: AddressLookupTableAccount.deserialize(info.data) }) : null,
    )
    .filter((x): x is AddressLookupTableAccount => Boolean(x));
};

// One atomic transaction: our fee transfer and the swap land together or not at all.
export const buildSwap = async (input: {
  payer: PublicKey;
  quote: Quote;
  before?: TransactionInstruction[];
  after?: TransactionInstruction[];
  destinationTokenAccount?: PublicKey;
  priority?: { maxLamports: number; level: "medium" | "high" | "veryHigh" };
}) => {
  const priority = input.priority ?? { maxLamports: 2_000_000, level: "veryHigh" };
  const res = await jfetch(`${swapBase()}/swap-instructions`, {
    method: "POST",
    body: JSON.stringify({
      quoteResponse: input.quote.raw,
      userPublicKey: input.payer.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: priority.maxLamports, priorityLevel: priority.level } },
      ...(input.destinationTokenAccount ? { destinationTokenAccount: input.destinationTokenAccount.toBase58() } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    computeBudgetInstructions?: RawIx[];
    setupInstructions?: RawIx[];
    swapInstruction?: RawIx;
    cleanupInstruction?: RawIx | null;
    otherInstructions?: RawIx[];
    addressLookupTableAddresses?: string[];
  };
  if (!res.ok || !body.swapInstruction) throw new Error(body.error || "Jupiter did not build the trade.");
  const ixs = [
    ...(body.computeBudgetInstructions ?? []).map(toIx),
    ...(input.before ?? []),
    ...(body.setupInstructions ?? []).map(toIx),
    toIx(body.swapInstruction),
    ...(body.cleanupInstruction ? [toIx(body.cleanupInstruction)] : []),
    ...(body.otherInstructions ?? []).map(toIx),
    ...(input.after ?? []),
  ];
  const alts = await lookupTables(body.addressLookupTableAddresses ?? []);
  const { blockhash, lastValidBlockHeight } = await rpc().getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: input.payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
  return { tx: new VersionedTransaction(message), lastValidBlockHeight };
};
