// Prints a brand new Solana wallet for TREASURY_SECRET or FEE_SECRET.
// Paste the secret straight into Railway's variables. Never save it in a file or chat.
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";

const kp = Keypair.generate();
console.log(`address: ${kp.publicKey.toBase58()}`);
console.log(`secret:  ${bs58.encode(kp.secretKey)}`);
if (process.argv.includes("--master-key")) console.log(`WALLET_MASTER_KEY: ${randomBytes(32).toString("base64")}`);
console.log("\nCopy the secret into Railway now, then clear this terminal.");
