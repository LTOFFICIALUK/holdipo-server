// Builds a real PreStocks payout exactly as the server does (open the holder's
// token account, buy with SOL, deliver into that account) for a treasury that
// already holds SOL, and simulates it on mainnet without signing.
// usage: RPC_URL=... tsx src/scripts/simulate-stock.ts <funded wallet> [openai|anthropic] [holder wallet]
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { rpc } from "../core/chain.js";
import { buildSwap, quote } from "../core/jupiter.js";
import { WSOL } from "../core/price.js";
import { STOCKS } from "../product/routes.js";

const [payerArg, which = "openai", holderArg] = process.argv.slice(2);
if (!payerArg) throw new Error("usage: simulate-stock <funded wallet> [openai|anthropic] [holder]");
const payer = new PublicKey(payerArg);
const holder = holderArg ? new PublicKey(holderArg) : Keypair.generate().publicKey;
const stock = STOCKS[which];
const mint = new PublicKey(stock.mint);
const ata = getAssociatedTokenAddressSync(mint, holder, true, TOKEN_2022_PROGRAM_ID);
const q = await quote({ inputMint: WSOL, outputMint: stock.mint, amount: 100_000_000n, slippageBps: 300 });
const built = await buildSwap({
  payer,
  quote: q,
  before: [createAssociatedTokenAccountIdempotentInstruction(payer, ata, holder, mint, TOKEN_2022_PROGRAM_ID)],
  destinationTokenAccount: ata,
  priority: { maxLamports: 200_000, level: "medium" },
});
const sim = await rpc().simulateTransaction(built.tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: [ata.toBase58()] } });
console.log(stock.symbol, { out: q.outAmount.toString(), err: sim.value.err, units: sim.value.unitsConsumed, ataLamports: sim.value.accounts?.[0]?.lamports, ataSize: sim.value.accounts?.[0]?.data?.[0] ? Buffer.from(sim.value.accounts[0].data[0], "base64").length : null });
if (sim.value.err) console.log(sim.value.logs?.slice(-15).join("\n"));
