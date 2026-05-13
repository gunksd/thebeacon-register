// Generate a fresh wallet, sign in (no referralCode → success), then query
// the user's own referral code via GraphQL. Saves inviter.json with the new
// code so register.js can use it via --referral=<code>.

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";

const ORIGIN = "https://app.thebeacon.gg";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const w = Wallet.createRandom();
const address = w.address;
const privateKey = w.privateKey;
const mnemonic = w.mnemonic?.phrase ?? "";

const jar = new Map();
function setCookies(headers) {
  const sc = headers.getSetCookie?.() ?? [headers.get("set-cookie")].filter(Boolean);
  for (const c of sc.flat()) {
    const [kv] = c.split(";");
    const eq = kv.indexOf("=");
    if (eq < 0) continue;
    const k = kv.slice(0, eq).trim();
    const v = kv.slice(eq + 1).trim();
    if (!v || v === "deleted") jar.delete(k);
    else jar.set(k, v);
  }
}
function H(extra = {}) {
  return {
    "user-agent": UA,
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    origin: ORIGIN,
    referer: `${ORIGIN}/pre-register`,
    cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    ...extra,
  };
}

console.log(`[inviter] new wallet ${address}`);

// 1. nonce
const r1 = await fetch(`${ORIGIN}/api/core/graphql`, {
  method: "POST",
  headers: H({ "content-type": "application/json" }),
  body: JSON.stringify({
    query:
      "mutation M { createSignatureNonce { __typename ... on CreateSignatureNonceSuccessResponse { signatureNonce { nonce id } } } }",
    variables: {},
  }),
});
setCookies(r1.headers);
const nonce = (await r1.json())?.data?.createSignatureNonce?.signatureNonce?.nonce;
if (!nonce) throw new Error("no nonce");
console.log(`[inviter] nonce ${nonce}`);

// 2. csrf
const r2 = await fetch(`${ORIGIN}/auth/csrf`, { headers: H() });
setCookies(r2.headers);
const csrfToken = (await r2.json()).csrfToken;

// 3. SIWE + callback (NO referralCode)
const message = [
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
const signature = await w.signMessage(message);

const r3 = await fetch(`${ORIGIN}/auth/callback/wallet`, {
  method: "POST",
  headers: H({ "content-type": "application/json" }),
  redirect: "manual",
  body: JSON.stringify({
    csrfToken,
    method: "wallet",
    callbackUrl: "/profile",
    message,
    signature,
  }),
});
setCookies(r3.headers);
const loc = r3.headers.get("location") ?? "";
console.log(`[inviter] callback ${r3.status} -> ${loc}`);
if (!loc.includes("/profile")) {
  throw new Error(`callback failed: ${loc || (await r3.text()).slice(0, 200)}`);
}

// 4. session
const r4 = await fetch(`${ORIGIN}/auth/session`, { headers: H() });
setCookies(r4.headers);
const session = await r4.json();
const userId = session?.user?.id;
const accessToken = session?.accessToken;
if (!userId || !accessToken) throw new Error(`no session: ${JSON.stringify(session)}`);
console.log(`[inviter] userId=${userId.slice(0, 30)}…`);

// 5. GraphQL query own referralCodes (auth via Bearer + cookies)
const r5 = await fetch(`${ORIGIN}/api/core/graphql`, {
  method: "POST",
  headers: H({
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
  }),
  body: JSON.stringify({
    query: `query Me {
      me {
        id
        referralCodes {
          edges {
            node { id code }
          }
        }
      }
    }`,
    variables: {},
  }),
});
const j5 = await r5.json();
const codes = j5?.data?.me?.referralCodes?.edges?.map((e) => e.node.code) ?? [];
console.log(`[inviter] referral codes: ${JSON.stringify(codes)}`);
if (codes.length === 0) {
  console.error("[inviter] no codes — full response:");
  console.error(JSON.stringify(j5, null, 2).slice(0, 1500));
  throw new Error("no referral code yet");
}

const code = codes[0];

mkdirSync(resolve(process.cwd(), "output"), { recursive: true });
const outPath = resolve(process.cwd(), "inviter.json");
writeFileSync(
  outPath,
  JSON.stringify(
    {
      address,
      privateKey,
      mnemonic,
      userId,
      referralCode: code,
      allCodes: codes,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);

console.log(`\n[inviter] DONE`);
console.log(`  address:      ${address}`);
console.log(`  referralCode: ${code}`);
console.log(`  saved to:     ${outPath}`);
console.log(`\nNow run:`);
console.log(`  node register.js --referral=${code} --concurrency=2 --delay=3000`);
