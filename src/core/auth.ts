import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { Request } from "express";
import { config } from "./config.js";
import { sql } from "./db.js";

export class AuthError extends Error {
  status = 401;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export const signInMessage = (product: string, wallet: string, nonce: string) =>
  [`Sign in to ${product}`, "", `wallet: ${wallet}`, `nonce: ${nonce}`, "", "This only proves you own this wallet. It does not move any funds."].join("\n");

// A nonce is single use and lasts 10 minutes. `purpose` ties it to one action.
export const issueNonce = async (wallet: string, purpose: string) => {
  new PublicKey(wallet);
  const nonce = randomBytes(16).toString("hex");
  await sql()`
    insert into nonces (nonce, wallet, purpose, expires_at) values (${nonce}, ${wallet}, ${purpose}, now() + interval '10 minutes')
  `;
  await sql()`delete from nonces where expires_at < now() - interval '1 day'`;
  return nonce;
};

export const verifySignature = (wallet: string, message: string, signatureB64: string) => {
  let sig: Uint8Array;
  try {
    sig = Uint8Array.from(Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  try {
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, new PublicKey(wallet).toBytes());
  } catch {
    return false;
  }
};

// Checks the nonce belongs to this wallet and action, is fresh and unused, and burns it.
export const useNonce = async (wallet: string, purpose: string, nonce: string) => {
  const [row] = await sql()`
    update nonces set used_at = now()
    where nonce = ${nonce} and wallet = ${wallet} and purpose = ${purpose} and used_at is null and expires_at > now()
    returning nonce
  `;
  if (!row) throw new AuthError("This signature request expired. Sign again.");
};

export const signIn = async (wallet: string, nonce: string, signature: string) => {
  const message = signInMessage(config.product, wallet, nonce);
  if (!verifySignature(wallet, message, signature)) throw new AuthError("The signature does not match this wallet.");
  await useNonce(wallet, "signin", nonce);
  const token = randomBytes(32).toString("hex");
  await sql()`insert into sessions (token_hash, wallet, expires_at) values (${hash(token)}, ${wallet}, now() + interval '7 days')`;
  await sql()`delete from sessions where expires_at < now()`;
  return token;
};

export const sessionWallet = async (req: Request) => {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new AuthError("Sign in with your wallet first.");
  const [row] = await sql()`select wallet from sessions where token_hash = ${hash(token)} and expires_at > now()`;
  if (!row) throw new AuthError("Your sign-in expired. Sign in again.");
  return row.wallet as string;
};

export const signOut = async (req: Request) => {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token) await sql()`delete from sessions where token_hash = ${hash(token)}`;
};
