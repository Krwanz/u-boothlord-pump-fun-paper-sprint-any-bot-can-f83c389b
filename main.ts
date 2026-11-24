// Momentum Sniper — a pump.fun paper-trading bot for the make.fun replay.
//
// Idea: new pump.fun coins usually make their biggest move in the first few
// minutes after creation, then fade. This bot watches every new coin, and
// buys a small fixed stake only once the coin has already proven buyers are
// pushing it up (price +10% over its creation price within its first 40
// trades, with real liquidity behind it). It then exits fast: take profit at
// +50%, stop loss at -30%, or a time exit after 12,000 slots (~80 minutes)
// so the five position slots keep turning over across many coins.
//
// This exact parameter set is the best of five variants graded on the dev
// window (buy-and-hold baseline: -0.02 SOL but only 5 coins, guardrails NOT
// met; earlier entry + tighter exits: worse; proven runners only: -2.82 SOL;
// buy-everything with stop-loss only: -2.93 SOL; tighter -15% stop: -2.39 SOL).
// The dev window is one small sample, so no variant was chased further than
// this — the final window is a different 6 hours, and a simple robust rule
// beats an overfitted one.
//
// Everything is deterministic: no clock, no randomness, no network — every
// decision comes from the harness batches alone, so two runs agree byte for
// byte. Per-batch work is proportional to that batch's events plus the (at
// most five) open positions, so the bot finishes well inside the time budget.
//
// Money: paper only. Capital is the harness's 10 SOL; each buy risks 0.05 SOL.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// --- tunables (all in whole units; ratios are exact bigint cross-products) ---
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per coin
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 50n; // 0.02 SOL: never buy dust
const MIN_REAL_SOL = LAMPORTS_PER_SOL / 2n; // 0.5 SOL of real reserves first
const MAX_TRADES_TO_ENTER = 40; // only early momentum counts
const MAX_SLIPPAGE_BPS = 10_000; // wide open: never lose a fill to latency
const MAX_HOLD_SLOTS = 12_000; // time exit

// Entry: price now >= 110% of creation price.
// Exit:  take profit at >= 150% of fill price, stop loss at <= 70%.
const ENTRY_NUM = 11n;
const ENTRY_DEN = 10n;
const TAKE_PROFIT_NUM = 3n;
const TAKE_PROFIT_DEN = 2n;
const STOP_LOSS_NUM = 7n;
const STOP_LOSS_DEN = 10n;

/** Price of one token in SOL, as the ratio virtual_quote / virtual_token. */
interface Price {
  q: bigint;
  t: bigint;
}

function priceOf(q: bigint, t: bigint): Price | null {
  if (q <= 0n || t <= 0n) return null;
  return { q, t };
}

/** True when price a is at least (num/den) times price b. Exact bigint math. */
function atLeastRatio(a: Price, b: Price, num: bigint, den: bigint): boolean {
  // a.q / a.t >= (num / den) * (b.q / b.t)
  // <=> a.q * b.t * den >= b.q * a.t * num
  return a.q * b.t * den >= b.q * a.t * num;
}

/** True when price a is at most (num/den) times price b. */
function atMostRatio(a: Price, b: Price, num: bigint, den: bigint): boolean {
  return a.q * b.t * den <= b.q * a.t * num;
}

interface Coin {
  /** Creation price (virtual reserves at the CreateEvent). */
  createPrice: Price;
  /** Price actually paid, from the buy fill (exact). */
  entryPrice: Price | null;
  /** Slot the buy was decided on (for the time exit). */
  entrySlot: number;
  /** A buy is already sent or filled: never buy twice. */
  bought: boolean;
  /** Decided and dropped (too old, completed, or skipped): never revisit. */
  done: boolean;
}

const coins = new Map<string, Coin>();

/** Update entry prices from this batch's fills (exact fill price beats the estimate). */
function learnFills(state: BotState, batch: Batch): void {
  for (const f of batch.fills) {
    if (f.side !== 'buy' || f.status !== 'filled') continue;
    const c = coins.get(f.mint);
    if (!c) continue;
    const p = priceOf(BigInt(f.quote_lamports), BigInt(f.token_amount));
    if (p) c.entryPrice = p;
  }
}

await runBot({
  onBatch(state, batch) {
    learnFills(state, batch);
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];

    // --- exits first: free position slots before deciding new entries ---
    for (const [mint, holding] of state.positions) {
      const c = coins.get(mint);
      const curve = state.curves.get(mint);
      if (!curve || curve.complete || holding.token_amount <= 0n) continue;
      const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (!now) continue;
      const entry = c?.entryPrice ?? null;
      let sell = false;
      if (entry) {
        if (atLeastRatio(now, entry, TAKE_PROFIT_NUM, TAKE_PROFIT_DEN)) sell = true;
        else if (atMostRatio(now, entry, STOP_LOSS_NUM, STOP_LOSS_DEN)) sell = true;
      }
      if (!sell && c && state.slot - c.entrySlot > MAX_HOLD_SLOTS) sell = true;
      if (!sell) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      const sellOrder: SellInput = {
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(sellOrder);
      if (c) c.done = true;
    }

    // --- entries: scan only this batch's events ---
    let free = state.freeCashLamports();
    // Sells in this reply return cash only after they fill, so do not count them here.
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (e.event === 'CreateEvent') {
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (p && !coins.has(e.mint)) {
          coins.set(e.mint, {
            createPrice: p,
            entryPrice: null,
            entrySlot: 0,
            bought: false,
            done: false,
          });
        }
        continue;
      }
      if (e.event === 'CompleteEvent') {
        const c = coins.get(e.mint);
        if (c) c.done = true;
        continue;
      }
      if (e.event !== 'TradeEvent') continue;
      const c = coins.get(e.mint);
      if (!c || c.bought || c.done) continue;
      const curve = state.curves.get(e.mint);
      if (!curve || curve.complete) {
        c.done = true;
        continue;
      }
      if (curve.trades > MAX_TRADES_TO_ENTER) {
        c.done = true;
        continue;
      }
      if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
      const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (!now) continue;
      if (!atLeastRatio(now, c.createPrice, ENTRY_NUM, ENTRY_DEN)) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (slots <= 0 || free < amount + tx) {
        // No room right now; a later trade may still catch it while it is young.
        if (curve.trades > MAX_TRADES_TO_ENTER) c.done = true;
        continue;
      }
      const buy: BuyInput = {
        side: 'buy',
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(buy);
      c.bought = true;
      c.entrySlot = state.slot;
      c.entryPrice = now; // estimate until the fill reports the exact price
      free -= amount + tx;
      slots -= 1;
    }
    return orders;
  },
});
