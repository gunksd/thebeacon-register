```
 ____  _____    _    ____ ___  _   _
| __ )| ____|  / \  / ___/ _ \| \ | |
|  _ \|  _|   / _ \| |  | | | |  \| |
| |_) | |___ / ___ \ |__| |_| | |\  |
|____/|_____/_/   \_\____\___/|_| \_|
   ____  _____ ____ ___ ____ _____ _____ ____
  |  _ \| ____/ ___|_ _/ ___|_   _| ____|  _ \
  | |_) |  _|| |  _ | |\___ \ | | |  _| | |_) |
  |  _ <| |__| |_| || | ___) || | | |___|  _ <
  |_| \_\_____\____|___|____/ |_| |_____|_| \_\
```

# thebeacon-register

Headless batch pre-registration for [The Beacon — Goblin's Gambit](https://app.thebeacon.gg/pre-register).
Generates EVM wallets, signs the SIWE login message offline, and submits the
referral-bound `auth/callback/wallet` request through plain `fetch`. No browser
required for the batch step.

> Use only with wallets you own. Bring your own referral code.

---

## Flow

```
 ┌──────────────────┐    1. createSignatureNonce (GraphQL)
 │  generate-wallets│──────────────────────────────────┐
 │       .js        │                                  │
 └────────┬─────────┘                                  ▼
          │                            ┌─────────────────────────┐
          │ wallets.csv                │  app.thebeacon.gg       │
          ▼                            │                         │
 ┌──────────────────┐                  │  /api/core/graphql      │
 │   register.js    │  ──── nonce ────►│  /auth/csrf             │
 │                  │  ◄── csrfToken ──│  /auth/callback/wallet  │
 │  ethers signMsg  │  ── SIWE+sig ──► │  /auth/session          │
 │  fetch + cookies │  ◄── userId ─────│                         │
 └──────────────────┘                  └─────────────────────────┘
```

The SIWE message format was captured from the live site (see `capture.js`):

```
app.thebeacon.gg wants you to sign in with your Ethereum account:
0xABCD...
                                                                        
Welcome to The Beacon! We now need to verify your account, please sign this message!

URI: https://app.thebeacon.gg
Version: 1
Chain ID: 42161
Nonce: <server-issued>
Issued At: <ISO-8601 now>
```

`POST /auth/callback/wallet` body:
```json
{
  "csrfToken": "...",
  "method": "wallet",
  "callbackUrl": "/profile",
  "message": "...",
  "signature": "0x...",
  "referralCode": "YOUR_CODE"
}
```

---

## Project layout

```
.
├── generate-wallets.js   # creates output/wallets.csv (index, address, privateKey, mnemonic)
├── register.js           # batch registration (fetch + ethers, no browser)
├── capture.js            # one-shot Playwright probe for the live flow (debug only)
├── package.json
└── output/               # gitignored — never commit this
    ├── wallets.csv
    ├── register-results.csv
    └── register.log
```

---

## Quick start

```bash
git clone https://github.com/gunksd/thebeacon-register.git
cd thebeacon-register
npm install

# 1. generate wallets
node generate-wallets.js 500

# 2. run the batch (resumable — already-OK rows are skipped on rerun)
node register.js --concurrency=3 --delay=1500

# 3. inspect results
column -t -s, output/register-results.csv | less -S
```

### CLI flags for `register.js`

| Flag             | Default        | Notes                                                                       |
| ---------------- | -------------- | --------------------------------------------------------------------------- |
| `--referral=`    | `YHDGDLXZTM`   | Referral code put into the callback body                                    |
| `--from=`        | `1`            | Start row in `wallets.csv` (1-based, inclusive)                             |
| `--to=`          | `Infinity`     | End row (inclusive)                                                         |
| `--concurrency=` | `3`            | Parallel workers. 2-3 is safe; higher values trigger Cloudflare rate limits |
| `--delay=`       | `1000`         | Per-worker sleep between wallets (ms)                                       |
| `--dry-run`      | off            | Sign but don't submit; useful for sanity checks                             |

Resumability is automatic: every `ok` row in `output/register-results.csv` is
skipped on rerun. Cloudflare 524 / 502 / 503 / 504 / `fetch failed` are retried
up to 3 times per wallet with backoff (the second attempt usually finishes
fast because the user record is already cached on the origin).

---

## Capturing the flow yourself (`capture.js`)

`capture.js` is a one-shot Playwright probe that:

1. Loads `output/wallets.csv` row 1 and rebuilds the wallet from its private key
2. Launches Chromium with an injected EIP-1193 + EIP-6963 provider that signs
   with that key (no MetaMask, no extension)
3. Drives the real "PRE REGISTER NOW → Continue with Wallet → Injected Signer
   → Sign message and Sign in" flow
4. Logs every non-static `app.thebeacon.gg` request and response to
   `output/captured.jsonl`

Use it whenever the site changes and you need to re-derive the API contract:

```bash
npx playwright install chromium
node capture.js
# inspect output/captured.jsonl
```

---

## Operational notes

- **Cloudflare 524**: the origin can take >100 seconds to create a brand-new
  user (referral binding + currency seeding). The script retries automatically;
  the second attempt for the same wallet usually returns 302 in <1 second.
- **Throughput**: 500 wallets at `--concurrency=3 --delay=1500` ≈ 4-6 hours.
  Going higher tends to trigger rate limits and slows the overall batch.
- **Resumability**: stop with Ctrl-C any time; rerun the same command.
- **Backups**: `generate-wallets.js` refuses to overwrite an existing
  `wallets.csv` — it timestamps the old one first.

---

## Security

`output/wallets.csv` contains private keys and BIP-39 mnemonics in clear text.

- The file is created with mode `0600`
- The whole `output/` directory is in `.gitignore` and **must never be
  committed**
- After registration, move `wallets.csv` off the dev machine (encrypted
  storage, hardware vault, whatever your operational standard is) and remove
  the local copy
- `capture.js` writes raw HTTP bodies — including a valid signature — to
  `output/captured.jsonl`. Treat that file with the same care

If you suspect any key in `wallets.csv` was exposed, treat that wallet as
compromised. Do not fund it.

---

## License

MIT — see `LICENSE`.
