// Cetus stats から対象2プールを取得し、data/history.json に追記する。
// 失敗・不正値のときは何も書かず exit 1(Actions の失敗通知で気づけるようにする)。
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STATS_URL, USDC_TYPE, extractPools, buildHistoryEntry, appendHistory } from '../calc.mjs';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'history.json');

async function fetchPools() {
  for (const qs of ['limit=10', 'limit=100', 'limit=100&offset=100', 'limit=100&offset=200']) {
    const res = await fetch(`${STATS_URL}?coin_type=${USDC_TYPE}&${qs}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pools = extractPools(await res.json());
    if (pools['500'] || pools['2500']) return pools;
  }
  throw new Error('対象プールが見つからない');
}

try {
  const pools = await fetchPools();
  const entry = buildHistoryEntry(pools, new Date().toISOString());
  if (!entry) throw new Error('有効なプールが無い');
  let history = [];
  try {
    history = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(history)) throw new Error('history.json が配列ではない');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await writeFile(file, JSON.stringify(appendHistory(history, entry)) + '\n');
  console.log('appended', entry.t, Object.keys(entry.pools).join(','));
} catch (e) {
  console.error('snapshot failed:', e.message);
  process.exit(1);
}
