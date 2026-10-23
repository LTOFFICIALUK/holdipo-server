import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { requireRpc } from "./config.js";

let connection: Connection | null = null;

export const rpc = () => {
  if (!connection) connection = new Connection(requireRpc(), "confirmed");
  return connection;
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const isAddress = (value: string) => {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
};

// Real people hold coins in wallets on the ed25519 curve. Pools, locks, vaults and
// other program accounts are off-curve PDAs, so they never count as holders.
export const isWallet = (value: string) => {
  try {
    return PublicKey.isOnCurve(new PublicKey(value).toBytes());
  } catch {
    return false;
  }
};

export const PRIORITY_MICROLAMPORTS = 50_000;

export type Prepared = {
  signature: string;
  raw: Buffer;
  lastValidBlockHeight: number;
};

// Signs a legacy transaction and returns its signature before anything is sent,
// so the caller can store the signature first and settle it after a crash.
export const prepareLegacy = async (
  instructions: TransactionInstruction[],
  signers: Keypair[],
  opts: { units?: number; feePayer?: PublicKey } = {},
): Promise<Prepared> => {
  const { blockhash, lastValidBlockHeight } = await rpc().getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: opts.feePayer || signers[0].publicKey, blockhash, lastValidBlockHeight });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.units ?? 200_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }));
  tx.add(...instructions);
  tx.sign(...signers);
  if (!tx.signature) throw new Error("The transaction was not signed.");
  return { signature: bs58.encode(tx.signature), raw: tx.serialize(), lastValidBlockHeight };
};

export const prepareVersioned = (tx: VersionedTransaction, lastValidBlockHeight: number): Prepared => {
  const first = tx.signatures[0];
  if (!first || first.every((b) => b === 0)) throw new Error("The transaction was not signed.");
  return { signature: bs58.encode(first), raw: Buffer.from(tx.serialize()), lastValidBlockHeight };
};

export type Settled = "confirmed" | "failed" | "expired" | "pending";

export const statusOf = async (signature: string, lastValidBlockHeight: number): Promise<Settled> => {
  const { value } = await rpc().getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = value[0];
  if (status) {
    if (status.err) return "failed";
    if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return "confirmed";
    return "pending";
  }
  const height = await rpc().getBlockHeight("confirmed");
  return height > lastValidBlockHeight ? "expired" : "pending";
};

// Sends and waits until the transaction lands, fails, or its blockhash expires.
export const sendPrepared = async (prepared: Prepared, timeoutMs = 90_000): Promise<Settled> => {
  const start = Date.now();
  let lastSend = 0;
  while (Date.now() - start < timeoutMs) {
    if (Date.now() - lastSend > 4_000) {
      lastSend = Date.now();
      await rpc()
        .sendRawTransaction(prepared.raw, { skipPreflight: true, maxRetries: 0 })
        .catch(() => undefined);
    }
    await sleep(1_500);
    const state = await statusOf(prepared.signature, prepared.lastValidBlockHeight).catch(() => "pending" as Settled);
    if (state !== "pending") return state;
  }
  return "pending";
};

// Simulates first so a doomed transaction is never sent.
export const simulateLegacy = async (prepared: Prepared) => {
  const tx = Transaction.from(prepared.raw);
  const result = await rpc().simulateTransaction(tx);
  return result.value.err ? JSON.stringify(result.value.err) : null;
};

export const feeOf = async (signature: string) => {
  const tx = await rpc().getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  return BigInt(tx?.meta?.fee ?? 0);
};

export const solBalance = async (address: PublicKey) => BigInt(await rpc().getBalance(address, "confirmed"));

export const transferIx = (from: PublicKey, to: PublicKey, lamports: bigint) =>
  SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });

export const RENT_EXEMPT_MIN = 890_880n;
