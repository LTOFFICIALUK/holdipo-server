// Reads a pump.fun coin's creator and the fees waiting in their vault, then
// builds the same claim transaction the server sends and simulates it on
// mainnet without signing. usage: RPC_URL=... tsx src/scripts/check-claim.ts <coin mint> [funded fee payer]
import { PublicKey, Transaction } from "@solana/web3.js";
import { rpc } from "../core/chain.js";
import { OnlinePumpSdk, PUMP_SDK, bondingCurvePda } from "../core/pumpsdk.js";

const mint = new PublicKey(process.argv[2] ?? "");
const info = await rpc().getAccountInfo(bondingCurvePda(mint));
if (!info) throw new Error("No pump.fun curve for that mint.");
const curve = PUMP_SDK.decodeBondingCurve(info);
const sdk = new OnlinePumpSdk(rpc());
const waiting = BigInt((await sdk.getCreatorVaultBalanceBothPrograms(curve.creator)).toString());
console.log({ creator: curve.creator.toBase58(), complete: curve.complete, cashback: curve.isCashbackCoin, creatorFeeBps: curve.creatorFeeBps.toString(), waitingLamports: waiting.toString() });
const payer = process.argv[3] ? new PublicKey(process.argv[3]) : curve.creator;
const ixs = await sdk.collectCoinCreatorFeeInstructions(curve.creator, payer);
const { blockhash } = await rpc().getLatestBlockhash();
const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(...ixs);
const sim = await rpc().simulateTransaction(tx);
console.log("claim simulation", { err: sim.value.err, instructions: ixs.length });
if (sim.value.err) console.log(sim.value.logs?.slice(-10).join("\n"));
