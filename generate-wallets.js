import { Wallet } from 'ethers';
import { writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const count = Number.parseInt(process.argv[2] ?? '500', 10);
if (!Number.isFinite(count) || count < 1) {
  console.error('Usage: node generate-wallets.js [count]  (default 500)');
  process.exit(1);
}

const outDir = resolve(process.cwd(), 'output');
mkdirSync(outDir, { recursive: true });

const csvPath = resolve(outDir, 'wallets.csv');

if (existsSync(csvPath)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = csvPath.replace(/\.csv$/, `.${stamp}.csv`);
  renameSync(csvPath, backup);
  console.log(`existing wallets.csv backed up -> ${backup}`);
}

const rows = ['index,address,privateKey,mnemonic'];

for (let i = 0; i < count; i++) {
  const w = Wallet.createRandom();
  const mnemonic = w.mnemonic?.phrase ?? '';
  rows.push(`${i + 1},${w.address},${w.privateKey},"${mnemonic}"`);
  if ((i + 1) % 50 === 0 || i + 1 === count) {
    console.log(`generated ${i + 1}/${count}`);
  }
}

writeFileSync(csvPath, rows.join('\n') + '\n', { mode: 0o600 });
console.log(`done. ${count} wallets -> ${csvPath}`);
