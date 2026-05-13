// Batch pre-register wallets against app.thebeacon.gg using captured flow.
//
// Each registered user can only invite a limited number (~10–15) before the
// referral binding starts failing with /auth/error?error=Configuration. So we
// keep a *pool* of referral codes:
//   - seed code from --referral=<code>
//   - every successful registration's wallet becomes a candidate inviter
//   - when the active code is exhausted (or marked dead), we log into a
//     candidate, query GraphQL for its referralCodes[0], add to the pool,
//     and keep going
//
// Usage:
//   node register.js --referral=ABCD1234
//   node register.js --referral=ABCD1234 --concurrency=2 --delay=3000
//   node register.js --ref-max=9                    (uses per code before rotating)
//   node register.js --from=1 --to=10 --dry-run

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
const SEED_REFERRAL = String(argv.get("referral") ?? "YHDGDLXZTM");
const FROM = Number.parseInt(argv.get("from") ?? "1", 10);
const TO = argv.get("to") ? Number.parseInt(argv.get("to"), 10) : Infinity;
const CONCURRENCY = Math.max(
  1,
  Number.parseInt(argv.get("concurrency") ?? "3", 10),
);
const DELAY = Math.max(0, Number.parseInt(argv.get("delay") ?? "1000", 10));
const REF_MAX = Math.max(1, Number.parseInt(argv.get("ref-max") ?? "9", 10));
const DRY_RUN = Boolean(argv.get("dry-run"));

const outDir = resolve(process.cwd(), "output");
mkdirSync(outDir, { recursive: true });
const csvPath = resolve(outDir, "wallets.csv");
const resultsPath = resolve(outDir, "register-results.csv");
const logPath = resolve(outDir, "register.log");
const poolPath = resolve(outDir, "referral-pool.json");

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
  const rows = readFileSync(resultsPath, "utf8").trim().split("\n").slice(1);
  for (const row of rows) {
    const [idx, , status] = row.split(",");
    if (status === "ok") done.add(Number.parseInt(idx, 10));
  }
  return done;
}

// --- HTTP helpers ---

function makeJar() {
  const jar = new Map();
  return {
    setFromHeader(setCookieHeader) {
      if (!setCookieHeader) return;
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
  };
}

function commonHeaders(jar, refCode, extra = {}) {
  const h = {
    "user-agent": UA,
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    origin: ORIGIN,
    referer: `${ORIGIN}/pre-register${refCode ? `?referralCode=${refCode}` : ""}`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...extra,
  };
  const cookie = jar.header();
  if (cookie) h.cookie = cookie;
  return h;
}

async function requestNonce(jar, refCode) {
  const res = await fetch(`${ORIGIN}/api/core/graphql`, {
    method: "POST",
    headers: commonHeaders(jar, refCode, {
      "content-type": "application/json",
    }),
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

async function requestCsrf(jar, refCode) {
  const res = await fetch(`${ORIGIN}/auth/csrf`, {
    method: "GET",
    headers: commonHeaders(jar, refCode),
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
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
}

async function submitCallback(jar, refCode, body) {
  const res = await fetch(`${ORIGIN}/auth/callback/wallet`, {
    method: "POST",
    headers: commonHeaders(jar, refCode, {
      "content-type": "application/json",
    }),
    redirect: "manual",
    body: JSON.stringify(body),
  });
  jar.setFromHeader(
    res.headers.getSetCookie?.() ?? res.headers.get("set-cookie"),
  );
  const location = res.headers.get("location") ?? "";
  if (res.status !== 302 && res.status !== 200) {
    const text = await res.text().catch(() => "");
    throw new Error(`callback status ${res.status}: ${text.slice(0, 200)}`);
  }
  if (location.includes("/auth/error")) {
    throw new Error(`auth error redirect: ${location}`);
  }
}

async function fetchSession(jar, refCode) {
  const res = await fetch(`${ORIGIN}/auth/session`, {
    method: "GET",
    headers: commonHeaders(jar, refCode),
  });
  jar.setFromHeader(
    res.headers.getSetCookie?.() ?? res.headers.get("set-cookie"),
  );
  return res.json().catch(() => ({}));
}

// --- referral pool ---

const referralPool = [
  { code: SEED_REFERRAL, used: 0, max: REF_MAX, dead: false },
];
const candidateInviters = []; // {address, privateKey}

function persistPool() {
  try {
    writeFileSync(poolPath, JSON.stringify(referralPool, null, 2) + "\n", {
      mode: 0o600,
    });
  } catch {}
}

function pickReferral() {
  return referralPool.find((r) => !r.dead && r.used < r.max) ?? null;
}

async function fetchReferralCodeFor({ address, privateKey }) {
  const w = new Wallet(privateKey);
  const jar = makeJar();
  // Login flow without referralCode (already registered).
  const nonce = await requestNonce(jar, null);
  const csrfToken = await requestCsrf(jar, null);
  const message = buildSiweMessage({ address, nonce });
  const signature = await w.signMessage(message);
  await submitCallback(jar, null, {
    csrfToken,
    method: "wallet",
    callbackUrl: "/profile",
    message,
    signature,
  });
  const session = await fetchSession(jar, null);
  const at = session?.accessToken;
  if (!at) throw new Error(`no accessToken when reading referral`);
  const r = await fetch(`${ORIGIN}/api/core/graphql`, {
    method: "POST",
    headers: commonHeaders(jar, null, {
      "content-type": "application/json",
      authorization: `Bearer ${at}`,
    }),
    body: JSON.stringify({
      query:
        "query Me { me { id referralCodes { edges { node { id code } } } } }",
      variables: {},
    }),
  });
  const j = await r.json();
  const codes =
    j?.data?.me?.referralCodes?.edges?.map((e) => e.node.code) ?? [];
  if (codes.length === 0) throw new Error("user has no referral codes yet");
  return codes[0];
}

let replenishing = null;
async function replenishPool() {
  if (replenishing) return replenishing;
  replenishing = (async () => {
    while (candidateInviters.length > 0) {
      const inv = candidateInviters.shift();
      try {
        const code = await fetchReferralCodeFor(inv);
        if (referralPool.some((r) => r.code === code)) continue;
        referralPool.push({ code, used: 0, max: REF_MAX, dead: false });
        persistPool();
        logLine(
          `  pool: + ${code} from ${inv.address} (pool size ${referralPool.length})`,
        );
        return;
      } catch (e) {
        logLine(
          `  pool: skip ${inv.address} — ${String(e.message).slice(0, 100)}`,
        );
      }
    }
    throw new Error("referral pool empty and no candidate inviters left");
  })();
  try {
    return await replenishing;
  } finally {
    replenishing = null;
  }
}

// --- per-wallet registration with referral rotation ---

async function registerOne(item) {
  const wallet = new Wallet(item.privateKey);
  if (wallet.address.toLowerCase() !== item.address.toLowerCase()) {
    throw new Error("csv address/privateKey mismatch");
  }
  if (DRY_RUN) {
    const sig = await wallet.signMessage(
      buildSiweMessage({ address: item.address, nonce: "X" }),
    );
    return { userId: `dry:${sig.slice(0, 18)}` };
  }

  const MAX_TRIES = 8; // includes referral rotations
  let lastErr;

  for (let tries = 1; tries <= MAX_TRIES; tries++) {
    let ref = pickReferral();
    if (!ref) {
      try {
        await replenishPool();
        ref = pickReferral();
      } catch (e) {
        throw new Error(`pool empty: ${e.message}`);
      }
    }
    if (!ref) throw new Error("no usable referral code");

    const jar = makeJar();
    try {
      const nonce = await requestNonce(jar, ref.code);
      const csrfToken = await requestCsrf(jar, ref.code);
      const message = buildSiweMessage({ address: item.address, nonce });
      const signature = await wallet.signMessage(message);
      await submitCallback(jar, ref.code, {
        csrfToken,
        method: "wallet",
        callbackUrl: "/profile",
        message,
        signature,
        referralCode: ref.code,
      });
      const session = await fetchSession(jar, ref.code);
      const userId = session?.user?.id;
      if (!userId)
        throw new Error(
          `no session.user.id: ${JSON.stringify(session).slice(0, 150)}`,
        );

      ref.used++;
      persistPool();
      candidateInviters.push({
        address: item.address,
        privateKey: item.privateKey,
      });
      return { userId, refCode: ref.code };
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message ?? err);

      // referral-side failure → mark dead, rotate, retry without counting against wallet
      if (/auth\/error|Configuration|no session\.user\.id/.test(msg)) {
        if (!ref.dead) {
          ref.dead = true;
          persistPool();
          logLine(
            `  referral ${ref.code} marked DEAD after ${ref.used} uses — rotating`,
          );
        }
        continue;
      }

      // transient network/Cloudflare → backoff, same code
      const transient =
        /\b(429|502|503|504|524)\b/.test(msg) ||
        /timeout|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
          msg,
        ) ||
        /no available server|Too Many Requests|ThrottlerException|Bad gateway/i.test(
          msg,
        );
      if (transient && tries < MAX_TRIES) {
        const wait = 5000 + tries * 5000 + Math.floor(Math.random() * 3000);
        logLine(
          `  #${item.index} attempt ${tries} transient — wait ${wait}ms — ${msg.slice(0, 100)}`,
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      throw err;
    }
  }
  throw lastErr ?? new Error("exhausted retries");
}

// --- main ---

const wallets = loadWallets().filter((w) => w.index >= FROM && w.index <= TO);
const done = alreadyDone();
const queue = wallets.filter((w) => !done.has(w.index));

// Seed candidateInviters with wallets that already registered successfully
// (from prior runs). This lets us rotate to a fresh referral code without
// going through a brand-new signup first.
for (const w of wallets) {
  if (done.has(w.index)) {
    candidateInviters.push({ address: w.address, privateKey: w.privateKey });
  }
}

logLine(
  `start seedReferral=${SEED_REFERRAL} refMax=${REF_MAX} total=${wallets.length} pending=${queue.length} candidateInviters=${candidateInviters.length} concurrency=${CONCURRENCY} delay=${DELAY}ms dry=${DRY_RUN}`,
);
persistPool();

let cursor = 0;
let okCount = 0;
let failCount = 0;

async function worker(id) {
  while (cursor < queue.length) {
    const item = queue[cursor++];
    try {
      const { userId, refCode } = await registerOne(item);
      okCount++;
      appendFileSync(
        resultsPath,
        `${item.index},${item.address},ok,${userId},\n`,
      );
      logLine(
        `  #${item.index} ${item.address} OK userId=${userId} ref=${refCode} (w${id})`,
      );
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

logLine(
  `done ok=${okCount} fail=${failCount} pool=${referralPool.length} dead=${referralPool.filter((r) => r.dead).length} -> ${resultsPath}`,
);
