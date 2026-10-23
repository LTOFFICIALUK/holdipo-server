// Creates a new wallet (or master key) and stores it straight into Railway
// variables for the linked service. The secret is never printed or saved.
// usage: npm run railway:secret -- TREASURY_SECRET [--service <name>]
//        npm run railway:secret -- FEE_SECRET [--service <name>]
//        npm run railway:secret -- WALLET_MASTER_KEY [--service <name>]
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const [name, flag, service] = process.argv.slice(2);
const allowed = ["TREASURY_SECRET", "FEE_SECRET", "WALLET_MASTER_KEY"];
if (!allowed.includes(name)) {
  console.log(`usage: railway:secret -- ${allowed.join("|")} [--service <name>]`);
  process.exit(1);
}
let value: string;
let address: string | null = null;
if (name === "WALLET_MASTER_KEY") {
  value = randomBytes(32).toString("base64");
} else {
  const kp = Keypair.generate();
  value = bs58.encode(kp.secretKey);
  address = kp.publicKey.toBase58();
}
const args = ["variables", "--set", `${name}=${value}`, "--skip-deploys"];
if (flag === "--service" && service) args.push("--service", service);
execFileSync("railway", args, { stdio: ["ignore", "ignore", "inherit"] });
console.log(`${name} is set in Railway.${address ? ` Address: ${address}` : ""}`);
if (name === "TREASURY_SECRET") console.log("Send 0.05 SOL to this address for network fees before launch.");
if (name === "FEE_SECRET") console.log("Send 0.01 SOL to this address so small fees can land in it.");
if (name === "WALLET_MASTER_KEY") console.log("Never change it after launch, or terminal wallets cannot be opened.");
