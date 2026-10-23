import { config, keypairFromEnv } from "./core/config.js";
import { claimAndMove } from "./core/claim.js";
import { sql } from "./core/db.js";
import { createApp, finishApp, json, wrap } from "./core/http.js";
import { excludedBase, startKeeper } from "./core/keeper.js";
import { watchLaunch } from "./core/launch.js";
import { errText, log } from "./core/log.js";
import { startPayLoop } from "./core/payloop.js";
import { preferenceRoutes } from "./core/prefs.js";
import { jupiterPrices } from "./core/price.js";
import { minFor, routeDefs, routeFor, settleStocks, STOCKS } from "./product/routes.js";

const creator = keypairFromEnv("CREATOR_SECRET");
const treasury = keypairFromEnv("TREASURY_SECRET");
if (!treasury) throw new Error("TREASURY_SECRET is required.");
if (creator?.publicKey.equals(treasury.publicKey)) throw new Error("CREATOR_SECRET and TREASURY_SECRET must be different wallets.");

const app = createApp({
  treasury: treasury.publicKey,
  extraStatus: async () => {
    const prices = await jupiterPrices(Object.values(STOCKS).map((s) => s.mint)).catch(() => new Map<string, number>());
    return {
      minStockUsd: config.minStockUsd,
      stocks: Object.entries(STOCKS).map(([id, s]) => ({ id, ...s, priceUsd: prices.get(s.mint) ?? null })),
    };
  },
});
preferenceRoutes(app, routeDefs());
app.get("/api/wallets", wrap(async (_req, res) => {
  json(res, { treasury: treasury.publicKey.toBase58(), deployWallet: creator?.publicKey.toBase58() ?? null });
}));
app.get("/api/payouts/recent", wrap(async (_req, res) => {
  json(res, {
    payouts: await sql()`
      select route, wallet, lamports, out_amount, out_symbol, signature, updated_at as at from payouts where status = 'confirmed' order by id desc limit 50
    `,
  });
}));
finishApp(app);
app.listen(config.port, () => log("server.listening", { port: config.port, product: config.product }));

let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
  process.exit(0);
});

// The deploy wallet key stays with Luke. The API stays up until he pastes it, then a restart watches the coin.
if (!creator) {
  log("server.waiting", { missing: "CREATOR_SECRET" });
} else {
  startPayLoop({ treasury, routeFor, minFor, settleOther: settleStocks(treasury) });
  startKeeper({
    bringIn: async () => {
      await claimAndMove(creator, treasury);
    },
    excluded: () => excludedBase(treasury.publicKey, creator.publicKey),
  });
  watchLaunch(creator.publicKey, () => stopped).catch((err) => log("launch.error", { error: errText(err) }));
}
