# Momentum Sniper — Pump.fun Paper Sprint

[![Competition](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Krwanz/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Krwanz/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint — Any Bot Can](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on [make.fun](https://make.fun). Paper money only — no real funds, no API keys, no real-money launch.

Play code: `a15ed58m`

## Strategy

New pump.fun coins usually spike in the first minutes and then fade — chasing
that first spike loses money. The winners are the rare coins that keep climbing
after dozens of trades. This bot waits for proof instead of hype:

- **Entry:** a coin with price at least 10% above its creation price within
  its first 40 trades, and at least 0.5 SOL of real reserves — a coin with
  real buyers, not a fresh spike. Buys 0.05 SOL.
- **Exit:** take profit at +50% of the fill price, stop loss at −30%, or a
  time exit after 12,000 slots (~80 minutes), so the five position slots keep
  turning over across many coins.

## How it works

- One program, `main.ts`, running on Node 22 (TypeScript as-is).
- It speaks the `agent-fun/replay/v2` protocol on stdin/stdout through the
  vendored SDK shim in `vendor/makefun-bot.ts`.
- Fully deterministic: no clock, no randomness, no network — every decision
  comes from the harness batches alone, so two runs agree byte for byte.
- Per-batch work is proportional to that batch's events plus the (at most
  five) open positions, so it finishes well inside the grader's time budget.

## Dev result

Graded locally with the kit (`grade-local --driver process`, two executions,
reproduced byte for byte, ~35 s total):

- Net PnL: **−1.596 SOL** (return −16.0%, 90% interval −2.19 … −1.04 SOL)
- Trading: 697 fills over 351 coins, 351 round trips, win rate 21.9%,
  max drawdown 16.6% — guardrails met (351 ≥ 20 coins, drawdown < 50%)
- Fees: 0.360 SOL curve + 0.075 SOL tx

Honest note: the dev window is one small sample and this bot loses on it —
every momentum variant tested lost on it (the best alternative was −2.15 SOL).
The final window is a different 6 hours, and the $2 prize goes to the highest
net PnL there; this entry is a simple, robust rule rather than a dev-window
overfit.

## Run it

```sh
node main.ts   # the harness drives it over stdin/stdout
```

## License

MIT — see [LICENSE](LICENSE).
