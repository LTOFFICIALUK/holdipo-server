import type { Express } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { isAddress } from "./chain.js";
import { sql } from "./db.js";
import { HttpError, json, standing, wrap } from "./http.js";
import { issueNonce, sessionWallet, useNonce, verifySignature } from "./auth.js";

export type RouteDef = {
  id: string;
  label: string;
  needsDest: boolean;
  // Throws an HttpError with a plain message when dest is not usable.
  validate?: (wallet: string, dest: string) => Promise<void>;
};

export const routeMessage = (product: string, wallet: string, route: string, dest: string | null, nonce: string) =>
  [`Set my ${product} payout`, "", `wallet: ${wallet}`, `payout: ${route}`, ...(dest ? [`send to: ${dest}`] : []), `nonce: ${nonce}`, "", "This only changes where your share is sent. It does not move any funds."].join("\n");

export const preferenceOf = async (wallet: string) => {
  const [row] = await sql()`select route, dest, updated_at from preferences where wallet = ${wallet}`;
  return row ? { route: row.route as string, dest: (row.dest as string) ?? null, updatedAt: row.updated_at as Date } : null;
};

// Payout settings change only with a fresh wallet signature over the exact
// route and address, so a stolen sign-in session cannot redirect anyone's money.
export const preferenceRoutes = (app: Express, routes: RouteDef[]) => {
  const ids = routes.map((r) => r.id) as [string, ...string[]];
  const body = z.object({
    wallet: z.string().refine(isAddress, "That is not a Solana wallet address."),
    route: z.enum(ids),
    dest: z.string().trim().max(200).optional().nullable(),
  });

  const check = async (input: z.infer<typeof body>) => {
    const def = routes.find((r) => r.id === input.route)!;
    const dest = def.needsDest ? input.dest?.trim() || "" : null;
    if (def.needsDest && !dest) throw new HttpError(400, "Enter the address to send to.");
    if (def.validate && dest) await def.validate(input.wallet, dest);
    return dest;
  };

  app.post("/api/payout/nonce", wrap(async (req, res) => {
    const input = body.parse(req.body);
    const dest = await check(input);
    const nonce = await issueNonce(input.wallet, `route:${input.route}:${dest ?? ""}`);
    json(res, { nonce, message: routeMessage(config.product, input.wallet, input.route, dest, nonce) });
  }));

  app.post("/api/payout", wrap(async (req, res) => {
    const input = body.extend({ nonce: z.string(), signature: z.string() }).parse(req.body);
    const dest = await check(input);
    const message = routeMessage(config.product, input.wallet, input.route, dest, input.nonce);
    if (!verifySignature(input.wallet, message, input.signature)) throw new HttpError(401, "The signature does not match this wallet.");
    await useNonce(input.wallet, `route:${input.route}:${dest ?? ""}`, input.nonce);
    await sql()`
      insert into preferences (wallet, route, dest, signed_message, signature) values (${input.wallet}, ${input.route}, ${dest}, ${message}, ${input.signature})
      on conflict (wallet) do update set route = excluded.route, dest = excluded.dest, signed_message = excluded.signed_message,
        signature = excluded.signature, updated_at = now()
    `;
    json(res, { ok: true, route: input.route, dest });
  }));

  // Private view: payout settings and destinations. Needs a sign-in.
  app.get("/api/me", wrap(async (req, res) => {
    const wallet = await sessionWallet(req);
    const [pref, stand, payouts] = await Promise.all([
      preferenceOf(wallet),
      standing(wallet),
      sql()`
        select id, route, dest, lamports, out_amount, out_symbol, signature, out_tx, status, error, not_before, created_at, updated_at
        from payouts where wallet = ${wallet} order by id desc limit 50
      `,
    ]);
    json(res, { ...stand, preference: pref ?? { route: routes[0].id, dest: null, updatedAt: null }, payouts });
  }));
};

export const isSolanaDest = async (wallet: string, dest: string) => {
  if (!isAddress(dest)) throw new HttpError(400, "That is not a Solana address.");
  if (dest === wallet) throw new HttpError(400, "Use a fresh address, not the wallet that holds the coin.");
};
