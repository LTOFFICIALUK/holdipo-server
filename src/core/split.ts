// Pure split math. No I/O, so every rule here is covered by tests.

export type SplitInput = {
  current: Map<string, bigint>;
  previous: Map<string, bigint> | null;
  excluded: Set<string>;
  isWallet: (address: string) => boolean;
  decimals: number;
  tokenPriceUsd: number;
  minHoldUsd: number;
  poolLamports: bigint;
};

export type Share = { wallet: string; balance: bigint; lamports: bigint };

export type SplitResult = {
  eligible: Share[];
  eligibleTokens: bigint;
  allocated: bigint;
  carry: bigint;
};

// The minimum raw balance that is worth minHoldUsd at the given price.
export const minRawBalance = (minHoldUsd: number, tokenPriceUsd: number, decimals: number) => {
  if (minHoldUsd <= 0) return 1n;
  if (!(tokenPriceUsd > 0)) return null;
  const tokens = minHoldUsd / tokenPriceUsd;
  const raw = Math.ceil(tokens * 10 ** decimals);
  if (!Number.isFinite(raw)) return null;
  return BigInt(raw);
};

// A wallet counts with the smaller of its last two balances, so buying just
// before a split and selling just after earns nothing.
export const heldThrough = (current: Map<string, bigint>, previous: Map<string, bigint> | null) => {
  const out = new Map<string, bigint>();
  if (!previous) return out;
  for (const [wallet, now] of current) {
    const before = previous.get(wallet) ?? 0n;
    const held = now < before ? now : before;
    if (held > 0n) out.set(wallet, held);
  }
  return out;
};

export const computeSplit = (input: SplitInput): SplitResult => {
  const minRaw = minRawBalance(input.minHoldUsd, input.tokenPriceUsd, input.decimals);
  const held = heldThrough(input.current, input.previous);
  const eligible: Share[] = [];
  let eligibleTokens = 0n;
  if (minRaw !== null) {
    for (const [wallet, balance] of held) {
      if (input.excluded.has(wallet)) continue;
      if (!input.isWallet(wallet)) continue;
      if (balance < minRaw) continue;
      eligible.push({ wallet, balance, lamports: 0n });
      eligibleTokens += balance;
    }
  }
  let allocated = 0n;
  if (eligibleTokens > 0n && input.poolLamports > 0n) {
    for (const row of eligible) {
      row.lamports = (input.poolLamports * row.balance) / eligibleTokens;
      allocated += row.lamports;
    }
  }
  eligible.sort((a, b) => (a.balance === b.balance ? (a.wallet < b.wallet ? -1 : 1) : a.balance > b.balance ? -1 : 1));
  return {
    eligible: eligible.filter((row) => row.lamports > 0n || input.poolLamports === 0n),
    eligibleTokens,
    allocated,
    carry: input.poolLamports - allocated,
  };
};

// What goes into a split: this round's holder share, plus anything carried
// over, minus network costs not yet recovered (when costs are deducted).
export const poolFor = (input: {
  sourceLamports: bigint;
  holderShareBps: number;
  carryLamports: bigint;
  unrecoveredCosts: bigint;
  deductCosts: boolean;
}) => {
  const share = (input.sourceLamports * BigInt(input.holderShareBps)) / 10_000n;
  const gross = share + input.carryLamports;
  if (!input.deductCosts || input.unrecoveredCosts <= 0n) {
    return { holderShare: share, pool: gross, recovered: 0n, stillUnrecovered: input.unrecoveredCosts };
  }
  const recovered = input.unrecoveredCosts < gross ? input.unrecoveredCosts : gross;
  return {
    holderShare: share,
    pool: gross - recovered,
    recovered,
    stillUnrecovered: input.unrecoveredCosts - recovered,
  };
};

// Fresh-address routes pay in round steps at a random later time, so the amount
// and the moment do not point back at one holder's share.
export const roundedRoute = (owed: bigint, step: bigint) => {
  if (step <= 0n) return owed;
  return (owed / step) * step;
};

export const nextSplitAt = (now: Date, minutes: number) => {
  const ms = minutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms + ms);
};
