# holdipo server

Holders of $IPO share the coin's pump.fun creator fees every 10 minutes. Each holder picks SOL, or the OpenAI or Anthropic PreStocks token, bought on Jupiter and delivered into their wallet.

Runs on Railway as one service (one replica). Postgres schema lives in the `holdipo-db` repo.

## What runs

- HTTP API on `PORT` (health at `/health`)
- the launch listener: watches the deploy wallet until it creates the pump.fun coin ending in `MINT_SUFFIX`, then the coin goes live on the site
- the split keeper: every 10 minutes it brings money into the treasury, snapshots holders and books each holder's share
- the payout loop: every minute it pays shares that passed their minimum
- `src/product/routes.ts` PreStocks payouts: opens the holder's Token-2022 account, swaps on Jupiter straight into it, returns unused rent
- `src/core/claim.ts` claims creator fees with the deploy wallet and moves the exact amount claimed to the treasury
- `src/core/` the split engine: launch listener, snapshots, splits, owed balances, SOL payouts, signed payout settings

## Env

Copy `.env.example`. Secrets go into Railway variables only, never into files or chat.
Create wallets with `npm run new-wallet`.

## Scripts

- `npm start` run the server
- `npm test` split math tests, `TEST_DATABASE_URL=... npm run test:db` engine tests against Postgres
- `npm run check -- [coin]` read-only health check (env, RPC, DB, prices, treasury), with a coin it also dry-runs a split
- `CONFIRM=yes npm run reset-launch` clears the coin and all split records, used once after the test coin
- `npm run check:claim -- <coin> [funded fee payer]` reads a coin's waiting creator fees and simulates the claim
- `npm run simulate:stock -- <funded wallet> [openai|anthropic]` builds a real PreStocks payout and simulates it on mainnet

## Rules the site shows

Every number the site shows comes from `/api/status`, which reads the same env the engine uses.
