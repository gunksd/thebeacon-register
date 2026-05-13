// Drives the pre-register flow in a real browser with an injected EIP-6963 wallet
// backed by ethers.js. Captures every app.thebeacon.gg API request/response so we
// can write a headless register.js afterwards.
//
// Usage: node capture.js
//        node capture.js --headed        (show browser)
//        node capture.js --wallet=1      (use row N from output/wallets.csv, 1-based)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";
import { chromium } from "playwright";

const REFERRAL = "YHDGDLXZTM";
const PRE_REGISTER_URL = `https://app.thebeacon.gg/pre-register?referralCode=${REFERRAL}`;
const ARB_ONE_HEX = "0xa4b1"; // 42161

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const headed = Boolean(args.get("headed"));
const walletIndex = Number.parseInt(args.get("wallet") ?? "1", 10);

function loadWallet(idx) {
  const csvPath = resolve(process.cwd(), "output", "wallets.csv");
  if (!existsSync(csvPath)) {
    throw new Error(`missing ${csvPath} — run: node generate-wallets.js 1`);
  }
  const rows = readFileSync(csvPath, "utf8").trim().split("\n").slice(1);
  if (idx < 1 || idx > rows.length) {
    throw new Error(`wallet index ${idx} out of range (have ${rows.length})`);
  }
  const [, address, privateKey] = rows[idx - 1].split(",");
  return new Wallet(privateKey);
}

const wallet = loadWallet(walletIndex);
console.log(`[capture] using wallet #${walletIndex} ${wallet.address}`);

const outDir = resolve(process.cwd(), "output");
mkdirSync(outDir, { recursive: true });
const logPath = resolve(outDir, "captured.jsonl");
writeFileSync(logPath, "");

function log(entry) {
  writeFileSync(logPath, JSON.stringify(entry) + "\n", { flag: "a" });
}

const browser = await chromium.launch({ headless: !headed });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
});

// Bridge: browser calls this to ask Node to sign a personal_sign message.
await ctx.exposeFunction("__nodeSign", async (message) => {
  console.log("[capture] personal_sign:", JSON.stringify(message));
  return wallet.signMessage(message);
});
await ctx.exposeFunction(
  "__nodeSignTypedData",
  async (domain, types, value) => {
    console.log("[capture] signTypedData domain:", domain?.name);
    // Remove EIP712Domain type from types — ethers rejects it
    const { EIP712Domain, ...rest } = types ?? {};
    return wallet.signTypedData(domain, rest, value);
  },
);
await ctx.exposeFunction("__nodeAddress", async () => wallet.address);

// Init script: installs an EIP-1193 provider and announces it via EIP-6963.
// Runs on every page before any site JS, in every frame.
await ctx.addInitScript(
  ({ address, chainIdHex }) => {
    const normAddr = address.toLowerCase();

    const listeners = new Map();

    const provider = {
      isMetaMask: true, // many sites only list MetaMask by default
      chainId: chainIdHex,
      networkVersion: String(parseInt(chainIdHex, 16)),
      selectedAddress: normAddr,
      async request(req) {
        const { method, params } = req || {};
        console.log(
          "[provider.request]",
          method,
          JSON.stringify(params)?.slice(0, 200),
        );
        switch (method) {
          case "eth_chainId":
            return chainIdHex;
          case "net_version":
            return String(parseInt(chainIdHex, 16));
          case "eth_accounts":
          case "eth_requestAccounts":
            return [normAddr];
          case "wallet_requestPermissions":
            return [{ parentCapability: "eth_accounts", caveats: [] }];
          case "wallet_getPermissions":
            return [{ parentCapability: "eth_accounts", caveats: [] }];
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            return null;
          case "personal_sign": {
            // params: [message, address] — message can be 0x-hex or plain utf8
            let [msg] = params;
            if (typeof msg === "string" && msg.startsWith("0x")) {
              try {
                const bytes = msg
                  .slice(2)
                  .match(/.{1,2}/g)
                  .map((h) => parseInt(h, 16));
                msg = new TextDecoder().decode(new Uint8Array(bytes));
              } catch {
                // leave as-is
              }
            }
            return window.__nodeSign(msg);
          }
          case "eth_sign": {
            const [, msg] = params;
            return window.__nodeSign(msg);
          }
          case "eth_signTypedData_v4":
          case "eth_signTypedData": {
            const [, raw] = params;
            const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
            return window.__nodeSignTypedData(
              obj.domain,
              obj.types,
              obj.message,
            );
          }
          default:
            throw Object.assign(new Error(`method ${method} not supported`), {
              code: 4200,
            });
        }
      },
      on(event, fn) {
        const arr = listeners.get(event) ?? [];
        arr.push(fn);
        listeners.set(event, arr);
      },
      removeListener(event, fn) {
        const arr = listeners.get(event) ?? [];
        listeners.set(
          event,
          arr.filter((f) => f !== fn),
        );
      },
    };

    // Legacy window.ethereum
    try {
      Object.defineProperty(window, "ethereum", {
        value: provider,
        writable: false,
        configurable: true,
      });
    } catch {
      window.ethereum = provider;
    }

    // EIP-6963 announce
    const info = {
      uuid: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
      name: "Injected Signer",
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
      rdns: "dev.injected.signer",
    };
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: Object.freeze({ info, provider }),
        }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  },
  { address: wallet.address, chainIdHex: ARB_ONE_HEX },
);

const page = await ctx.newPage();

page.on("console", (msg) => {
  const txt = msg.text();
  if (/provider\.request|__nodeSign|announceProvider|EIP-6963/i.test(txt)) {
    console.log("[browser]", txt);
  }
});

// Capture every non-static request/response touching the app.
page.on("request", (req) => {
  const url = req.url();
  if (!/app\.thebeacon\.gg|thebeacon\.gg\/api/i.test(url)) return;
  if (/\.(js|css|png|jpg|jpeg|svg|woff2?|ico|map)(\?|$)/i.test(url)) return;
  log({
    t: Date.now(),
    kind: "request",
    method: req.method(),
    url,
    headers: req.headers(),
    body: req.postData(),
  });
});

page.on("response", async (res) => {
  const url = res.url();
  if (!/app\.thebeacon\.gg|thebeacon\.gg\/api/i.test(url)) return;
  if (/\.(js|css|png|jpg|jpeg|svg|woff2?|ico|map)(\?|$)/i.test(url)) return;
  let body;
  try {
    body = await res.text();
    if (body.length > 4000) body = body.slice(0, 4000) + "…[truncated]";
  } catch {
    body = null;
  }
  log({
    t: Date.now(),
    kind: "response",
    status: res.status(),
    url,
    headers: res.headers(),
    body,
  });
});

console.log(`[capture] opening ${PRE_REGISTER_URL}`);
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    await page.goto(PRE_REGISTER_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    break;
  } catch (e) {
    console.error(`[capture] goto attempt ${attempt} failed: ${e.message}`);
    if (attempt === 3) throw e;
    await page.waitForTimeout(2000);
  }
}

// Dismiss cookie banners / wait for hero
await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

try {
  await page
    .getByRole("button", { name: /PRE REGISTER NOW/i })
    .first()
    .click({ timeout: 20_000 });
  console.log("[capture] clicked PRE REGISTER NOW");
} catch (e) {
  console.error("[capture] could not find PRE REGISTER NOW:", e.message);
}

await page.waitForTimeout(1500);

try {
  await page
    .getByRole("button", { name: /Continue with Wallet/i })
    .first()
    .click({ timeout: 20_000 });
  console.log("[capture] clicked Continue with Wallet");
} catch (e) {
  console.error("[capture] Continue with Wallet missing:", e.message);
}

await page.waitForTimeout(2500);

// Poll the wallet picker until Injected Signer is clickable (AppKit renders async).
let picked = false;
for (let attempt = 1; attempt <= 20 && !picked; attempt++) {
  await page.waitForTimeout(1000);
  const pickerButtons = await page
    .locator('[role="alertdialog"], wcm-modal, w3m-modal, appkit-modal')
    .locator("button, w3m-list-wallet, wui-list-wallet")
    .all();
  if (attempt === 1 || pickerButtons.length === 0 || attempt % 5 === 0) {
    console.log(
      `[capture] picker attempt ${attempt}: ${pickerButtons.length} elements`,
    );
  }
  for (let i = 0; i < pickerButtons.length; i++) {
    const txt = (await pickerButtons[i].textContent().catch(() => "")) ?? "";
    if (/Injected Signer/i.test(txt)) {
      await pickerButtons[i]
        .click()
        .catch((e) => console.error("click failed:", e.message));
      console.log(
        `[capture] selected wallet [${i}] (Injected Signer) on attempt ${attempt}`,
      );
      picked = true;
      break;
    }
  }
}
if (!picked) {
  console.log("[capture] could not find Injected Signer in picker");
}

// After connection, AppKit may show a "Sign in" / "Approve" dialog.
// Poll for any clickable buttons in the modal and click signing-related ones.
console.log("[capture] post-connect: poll for sign/approve buttons");
const seen = new Set();
for (let attempt = 1; attempt <= 30; attempt++) {
  await page.waitForTimeout(1000);
  const all = await page
    .locator(
      '[role="alertdialog"], [role="dialog"], wcm-modal, w3m-modal, appkit-modal',
    )
    .locator("button")
    .all();
  for (const btn of all) {
    const txt = ((await btn.textContent().catch(() => "")) ?? "").trim();
    if (!txt || seen.has(txt)) continue;
    seen.add(txt);
    console.log(`[capture] modal button: ${JSON.stringify(txt.slice(0, 80))}`);
    if (/sign in|approve|sign message|continue|confirm|verify/i.test(txt)) {
      await btn.click().catch((e) => console.error("click fail:", e.message));
      console.log(`[capture] clicked ${JSON.stringify(txt.slice(0, 40))}`);
    }
  }
}

// Wait for SIWE round-trip; give it up to 60s.
console.log("[capture] waiting for register round-trip…");
await page.waitForTimeout(45_000);

await browser.close();
console.log(`[capture] done. log -> ${logPath}`);
