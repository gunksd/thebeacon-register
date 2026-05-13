// Batch pre-register wallets against app.thebeacon.gg using captured flow:
//   1) POST /api/core/graphql  mutation createSignatureNonce  → nonce
//   2) GET  /auth/csrf                                        → csrfToken (+ csrf cookie)
//   3) Build SIWE message, sign with the wallet's private key
//   4) POST /auth/callback/wallet {csrfToken, method:"wallet", callbackUrl:"/profile",
//                                  message, signature, referralCode}
//   5) GET  /auth/session                                      → confirm session
//
// Usage:
//   node register.js                          (all wallets in output/wallets.csv)
//   node register.js --from=1 --to=10
//   node register.js --concurrency=5 --delay=1500
//   node register.js --referral=YHDGDLXZTM --dry-run

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";

const ORIGIN = "https://app.thebeacon.gg";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const argv = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const REFERRAL = String(argv.get("referral") ?? "YHDGDLXZTM");
const FROM = Number.parseInt(argv.get("from") ?? "1", 10);
const TO = argv.get("to") ? Number.parseInt(argv.get("to"), 10) : Infinity;
const CONCURRENCY = Math.max(
  1,
  Number.parseInt(argv.get("concurrency") ?? "3", 10),
);
const DELAY = Math.max(0, Number.parseInt(argv.get("delay") ?? "1000", 10));
const DRY_RUN = Boolean(argv.get("dry-run"));

const outDir = resolve(process.cwd(), "output");
mkdirSync(outDir, { recursive: true });
const csvPath = resolve(outDir, "wallets.csv");
const resultsPath = resolve(outDir, "register-results.csv");
const logPath = resolve(outDir, "register.log");

if (!existsSync(csvPath)) {
  console.error(`missing ${csvPath} — run: node generate-wallets.js <n>`);
  process.exit(1);
}

if (!existsSync(resultsPath)) {
  writeFileSync(resultsPath, "index,address,status,userId,error\n");
}

function logLine(s) {
  const line = `[${new Date().toISOString()}] ${s}`;
  console.log(line);
  appendFileSync(logPath, line + "\n");
}

function loadWallets() {
  const rows = readFileSync(csvPath, "utf8").trim().split("\n").slice(1);
  return rows.map((row, i) => {
    const [, address, privateKey] = row.split(",");
    return { index: i + 1, address, privateKey };
  });
}

function alreadyDone() {
  const done = new Set();
  if (!existsSync(resultsPath)) return done;
  const rows = readFileSync(resultsPath, "utf8").trim().split("\n").slice(1);
  for (const row of rows) {
    const [idx, , status] = row.split(",");
    if (status === "ok") done.add(Number.parseInt(idx, 10));
  }
  return done;
}

// Minimal cookie jar: scope-agnostic (one origin) — keep name=value only.
function makeJar() {
  const jar = new Map();
  return {
    setFromHeader(setCookieHeader) {
      if (!setCookieHeader) return;
      // undici exposes set-cookie as a single joined string; split conservatively.
      const parts = Array.isArray(setCookieHeader)
        ? setCookieHeader
        : setCookieHeader.split(/,(?=[^;]+=)/);
      for (const c of parts) {
        const [kv] = c.split(";");
        const eq = kv.indexOf("=");
        if (eq < 0) continue;
        const k = kv.slice(0, eq).trim();
        const v = kv.slice(eq + 1).trim();
        if (v === "" || v === "deleted") jar.delete(k);
        else jar.set(k, v);
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get(k) {
      return jar.get(k);
    },
  };
}

function commonHeaders(jar, extra = {}) {
  const h = {
    "user-agent": UA,
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    origin: ORIGIN,
    referer: `${ORIGIN}/pre-register?referralCode=${REFERRAL}`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...extra,
  };
  const cookie = jar.header();
  if (cookie) h.cookie = cookie;
  return h;
}

async function requestNonce(jar) {
  const res = await fetch(`${ORIGIN}/api/core/graphql`, {
    method: "POST",
    headers: commonHeaders(jar, { "content-type": "application/json" }),
    body: JSON.stringify({
      query:
        "mutation useCreateNonceCreateNonceMutation { createSignatureNonce { __typename ... on CreateSignatureNonceSuccessResponse { signatureNonce { nonce id } } ... on CreateSignatureNonceFailResponse { errorCode _isError } } }",
      variables: {},
    }),
  });
  jar.setFromHeader(
    res.headers.getSetCookie?.() ?? res.headers.get("set-cookie"),
  );
  const json = await res.json();
  const node = json?.data?.createSignatureNonce;
  if (node?.__typename !== "CreateSignatureNonceSuccessResponse") {
    throw new Error(`nonce failed: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return node.signatureNonce.nonce;
}

async function requestCsrf(jar) {
  const res = await fetch(`${ORIGIN}/auth/csrf`, {
    method: "GET",
    headers: commonHeaders(jar),
  });
  jar.setFromHeader(
    res.headers.getSetCookie?.() ?? res.headers.get("set-cookie"),
  );
  const json = await res.json();
  if (!json?.csrfToken)
    throw new Error(`csrf failed: ${JSON.stringify(json).slice(0, 300)}`);
  return json.csrfToken;
}

function buildSiweMessage({ address, nonce }) {
  const issuedAt = new Date().toISOString();
  return [
    `app.thebeacon.gg wants you to sign in with your Ethereum account:`,
    address,
    ``,
    `Welcome to The Beacon! We now need to verify your account, please sign this message!`,
    ``,
    `URI: ${ORIGIN}`,
    `Version: 1`,
    `Chain ID: 42161`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

async function submitCallback(jar, { csrfToken, message, signature }) {
  const res = await fetch(`${ORIGIN}/auth/callback/wallet`, {
    method: "POST",
    headers: commonHeaders(jar, { "content-type": "application/json" }),
    redirect: "manual",
    body: JSON.stringify({
      csrfToken,
      method: "wallet",
      callbackUrl: "/profile",
      message,
      signature,
      referralCode: REFERRAL,
    }),
  });
  jar.setFromHeader(
    res.headers.getSetCookie?.() ?? res.headers.get("set-cookie"),
  );
  if (res.status !== 302 && res.status !== 200) {
    const text = await res.text().catch(() => "");
    throw new Error(`callback status ${res.status}: ${text.slice(0, 300)}`);
  }
}

async function fetchSession(jar) {
  const res = await fetch(`${ORIGIN}/auth/session`, {
    method: "GET",
    headers: commonHeaders(jar),
  });
  jar.setFromHeader(
    res.headers.getSetCookie?.() ?? res.headers.get("set-cookie"),
  );
  return res.json().catch(() => ({}));
}

async function registerOne({ index, address, privateKey }) {
  const wallet = new Wallet(privateKey);
  if (wallet.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error("csv address/privateKey mismatch");
  }

  if (DRY_RUN) {
    const nonce = "DRYRUN000000000";
    const msg = buildSiweMessage({ address, nonce });
    const sig = await wallet.signMessage(msg);
    return { userId: `dry:${sig.slice(0, 18)}` };
  }

  // Cloudflare often returns 524 on the first callback for a brand new wallet
  // because the origin's "create user + bind referral" path is slow. Retrying
  // with the same wallet hits the cached user path and finishes in <1s.
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const jar = makeJar();
    try {
      const nonce = await requestNonce(jar);
      const csrfToken = await requestCsrf(jar);
      const message = buildSiweMessage({ address, nonce });
      const signature = await wallet.signMessage(message);
      await submitCallback(jar, { csrfToken, message, signature });
      const session = await fetchSession(jar);
      const userId = session?.user?.id;
      if (!userId)
        throw new Error(
          `no session.user.id: ${JSON.stringify(session).slice(0, 200)}`,
        );
      return { userId, attempts: attempt };
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message ?? err);
      const retriable =
        /\b(524|502|503|504|timeout|fetch failed|ECONNRESET)\b/i.test(msg);
      if (!retriable || attempt === MAX_ATTEMPTS) throw err;
      const wait = 2000 * attempt;
      logLine(
        `  #${index} attempt ${attempt} retriable error, waiting ${wait}ms — ${msg.slice(0, 120)}`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// --- main: bounded concurrency over the wallet slice ---

const wallets = loadWallets().filter((w) => w.index >= FROM && w.index <= TO);
const done = alreadyDone();
const queue = wallets.filter((w) => !done.has(w.index));

logLine(
  `start referral=${REFERRAL} total=${wallets.length} pending=${queue.length} concurrency=${CONCURRENCY} delay=${DELAY}ms dry=${DRY_RUN}`,
);

let cursor = 0;
let okCount = 0;
let failCount = 0;

async function worker(id) {
  while (cursor < queue.length) {
    const item = queue[cursor++];
    try {
      const { userId } = await registerOne(item);
      okCount++;
      appendFileSync(
        resultsPath,
        `${item.index},${item.address},ok,${userId},\n`,
      );
      logLine(`  #${item.index} ${item.address} OK userId=${userId} (w${id})`);
    } catch (err) {
      failCount++;
      const msg = String(err?.message ?? err)
        .replace(/[\r\n,]+/g, " ")
        .slice(0, 200);
      appendFileSync(
        resultsPath,
        `${item.index},${item.address},fail,,${msg}\n`,
      );
      logLine(`  #${item.index} ${item.address} FAIL ${msg} (w${id})`);
    }
    if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
  }
}

const workers = Array.from(
  { length: Math.min(CONCURRENCY, queue.length) },
  (_, i) => worker(i + 1),
);
await Promise.all(workers);

logLine(`done ok=${okCount} fail=${failCount} -> ${resultsPath}`);
