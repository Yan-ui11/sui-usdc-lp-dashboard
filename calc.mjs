// 計算ロジック。index.html / scripts/snapshot.mjs / tests から共有する(DOM非依存)。
// 単位: P, Pa, Pb は USD/SUI の人間単位。USDC = 1 USD として扱う。

export const POOLS = {
  500: {
    label: '0.05%',
    address: '0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab',
  },
  2500: {
    label: '0.25%',
    address: '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105',
  },
};
export const USDC_TYPE =
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
export const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
export const STATS_URL = 'https://api-sui.cetus.zone/v2/sui/stats_pools';

// Cetus GlobalConfig の protocol_fee_rate (分母 10000, 初期 2000 = 20%)。stats API には含まれない。
export const PROTOCOL_FEE_RATE = 0.2;
export const RANGES = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.5];
export const DEFAULT_SIGMA = 0.06; // 日次(対数リターン)。履歴が溜まるまでの暫定値。
export const MIN_SIGMA_SAMPLES = 28;
export const HISTORY_LIMIT = 1460;
export const T_DAYS = 7;

const DEC_A = 6; // USDC
const DEC_B = 9; // SUI

/* ---------- 価格 ---------- */

/** current_sqrt_price (Q64.64 の文字列) → USD/SUI。BigInt同士の除算はしない。 */
export function poolPrice(sqrtPriceStr) {
  const s = Number(BigInt(sqrtPriceStr)) / 2 ** 64;
  const rawSuiPerUsdc = s * s;
  const suiPerUsdc = rawSuiPerUsdc * 10 ** (DEC_A - DEC_B);
  return 1 / suiPerUsdc;
}

/** Cetus liquidity (raw) → 人間単位 L。√(10^6 · 10^9) = 10^7.5 で割る。 */
export function poolLiquidityHuman(liquidityStr) {
  return Number(BigInt(liquidityStr)) / 10 ** ((DEC_A + DEC_B) / 2);
}

/* ---------- パーサ ---------- */

/** "13.76%" → 0.1376 / "0.6695" → 0.6695 / 数値はそのまま小数 */
export function parsePct(v) {
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s.endsWith('%')) return Number(s.slice(0, -1)) / 100;
  return Number(s);
}

const finitePos = (x) => Number.isFinite(x) && x > 0;

/* ---------- 正規分布 ---------- */

function erfSeries(x) {
  let term = x;
  let sum = x;
  for (let n = 1; n < 100; n++) {
    term *= (-x * x) / n;
    const add = term / (2 * n + 1);
    sum += add;
    if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
  }
  return (2 / Math.sqrt(Math.PI)) * sum;
}

function erfcLarge(x) {
  // x >= 3: 連分数 erfc(x) = e^{-x²}/√π · 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + ...))))
  let f = x;
  for (let k = 60; k >= 1; k--) f = x + k / 2 / f;
  return Math.exp(-x * x) / Math.sqrt(Math.PI) / f;
}

export function erf(x) {
  const ax = Math.abs(x);
  if (ax < 3) return erfSeries(x);
  const v = 1 - erfcLarge(ax);
  return x < 0 ? -v : v;
}

export function normCdf(x) {
  if (x < -3 * Math.SQRT2) return 0.5 * erfcLarge(-x / Math.SQRT2);
  if (x > 3 * Math.SQRT2) return 1 - 0.5 * erfcLarge(x / Math.SQRT2);
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/* ---------- CLMM ---------- */

/** 資金 V(USD) と価格範囲から人間単位の流動性 L。 */
export function clmmLiquidity(P, Pa, Pb, V) {
  return V / (2 * Math.sqrt(P) - Math.sqrt(Pa) - P / Math.sqrt(Pb));
}

/** 流動性 L のポジションが価格 Px のときに持つ数量 { x: SUI, y: USDC }。 */
export function amountsAt(L, Px, Pa, Pb) {
  const sa = Math.sqrt(Pa);
  const sb = Math.sqrt(Pb);
  if (Px <= Pa) return { x: L * (1 / sa - 1 / sb), y: 0 };
  if (Px >= Pb) return { x: 0, y: L * (sb - sa) };
  const s = Math.sqrt(Px);
  return { x: L * (1 / s - 1 / sb), y: L * (s - sa) };
}

/** 数量 (x: SUI, y: USDC) から L を逆算。範囲内で片方が0なら null(入力不整合)。 */
export function liquidityFromAmounts(x, y, P, Pa, Pb) {
  const sa = Math.sqrt(Pa);
  const sb = Math.sqrt(Pb);
  if (P <= Pa) return x > 0 ? x / (1 / sa - 1 / sb) : null;
  if (P >= Pb) return y > 0 ? y / (sb - sa) : null;
  if (!(x > 0) || !(y > 0)) return null;
  const s = Math.sqrt(P);
  return Math.min(x / (1 / s - 1 / sb), y / (s - sa));
}

/** 同じ資金を全範囲に置いた場合に対する資本効率倍率。 */
export function capitalEfficiency(P, Pa, Pb) {
  return (2 * Math.sqrt(P)) / (2 * Math.sqrt(P) - Math.sqrt(Pa) - P / Math.sqrt(Pb));
}

/* ---------- tick ---------- */

const LN_1_0001 = Math.log(1.0001);
/** USD/SUI → raw tick(連続値)。raw価格 = SUI_raw/USDC_raw = (1/P)×10^3。 */
export function usdToTick(P) {
  return Math.log((1 / P) * 10 ** (DEC_B - DEC_A)) / LN_1_0001;
}
export function tickToUsd(tick) {
  return 1 / (Math.pow(1.0001, tick) / 10 ** (DEC_B - DEC_A));
}

/**
 * 中心価格 P と ±r から tick 丸めした範囲を返す。
 * USDの下限 Pa は raw の上限 tick に対応する(順序反転)。最近傍丸め(Cetus UI と同じ)。
 */
export function tickRange(P, r, tickSpacing) {
  return tickRangeFromPrices(P * (1 - r), P * (1 + r), tickSpacing);
}

export function tickRangeFromPrices(PaIn, PbIn, tickSpacing) {
  const s = Number(tickSpacing);
  const snap = (t) => Math.round(t / s) * s;
  let tickUpper = snap(usdToTick(PaIn)); // USD下限 ↔ raw上限
  let tickLower = snap(usdToTick(PbIn)); // USD上限 ↔ raw下限
  if (tickLower >= tickUpper) tickUpper = tickLower + s;
  return { tickLower, tickUpper, Pa: tickToUsd(tickUpper), Pb: tickToUsd(tickLower) };
}

/* ---------- 確率 ---------- */

/** 7日(T)以内にレンジ外へ一度でも出る確率。二重バリア・鏡像法、ドリフト0。 */
export function exitProbability(P, Pa, Pb, sigmaDaily, T = T_DAYS) {
  return 1 - stayProbability(P, Pa, Pb, sigmaDaily, T);
}

export function stayProbability(P, Pa, Pb, sigmaDaily, T = T_DAYS) {
  const a = Math.log(Pa / P);
  const b = Math.log(Pb / P);
  const w = b - a;
  const s = sigmaDaily * Math.sqrt(T);
  const K = Math.max(6, Math.ceil((3 * s) / w) + 2);
  let sum = 0;
  for (let k = -K; k <= K; k++) {
    sum +=
      normCdf((b - 2 * k * w) / s) -
      normCdf((a - 2 * k * w) / s) -
      normCdf((-b - 2 * k * w) / s) +
      normCdf((a - 2 * b - 2 * k * w) / s);
  }
  return Math.min(1, Math.max(0, sum));
}

/** 期待滞在率 (1/T)∫₀ᵀ[Φ(b/σ√t) − Φ(a/σ√t)]dt。中点則、t=0 は評価しない。 */
export function expectedStay(P, Pa, Pb, sigmaDaily, T = T_DAYS, n = 400) {
  const a = Math.log(Pa / P);
  const b = Math.log(Pb / P);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * T;
    const sd = sigmaDaily * Math.sqrt(t);
    sum += normCdf(b / sd) - normCdf(a / sd);
  }
  return sum / n;
}

/* ---------- 手数料 ---------- */

/**
 * pool: { feeRatePpm, liquidityHuman, tvl, vol24h, rewarderAprs: number[] }
 * 戻り値: 1レンジ分の行。
 */
export function rangeFee({ P, Pa, Pb, V, pool, volume, stay, sigma, pf = PROTOCOL_FEE_RATE }) {
  const L = clmmLiquidity(P, Pa, Pb, V);
  const Lp = pool.liquidityHuman;
  const share = L / (Lp + L);
  const feeRate = pool.feeRatePpm / 1e6;
  const vol = volume ?? pool.vol24h;
  const st = stay ?? expectedStay(P, Pa, Pb, sigma);
  const dailyFee = vol * feeRate * (1 - pf) * share * st;
  const poolRewardDaily = pool.rewarderAprs.reduce((a, b) => a + b, 0) * pool.tvl / 365;
  const dailyReward = poolRewardDaily * share * st;
  const capEff = capitalEfficiency(P, Pa, Pb);
  const concentration = (2 * Math.sqrt(P) * Lp) / pool.tvl;
  const poolAvgApr = (vol * feeRate * (1 - pf) * 365) / pool.tvl;
  const apr = (dailyFee * 365) / V;
  return {
    L,
    share,
    stay: st,
    dailyFee,
    dailyReward,
    apr,
    aprWithReward: ((dailyFee + dailyReward) * 365) / V,
    capEff,
    concentration,
    poolAvgApr,
    poolAvgRatio: apr / poolAvgApr,
    exitProb: sigma != null ? exitProbability(P, Pa, Pb, sigma) : null,
  };
}

/* ---------- 損益 ---------- */

/** 価格 Px での評価額と数量。 */
export function positionValueAt(L, Px, Pa, Pb) {
  const { x, y } = amountsAt(L, Px, Pa, Pb);
  return { x, y, value: x * Px + y };
}

/** IL = LP評価額 − 初期数量をそのまま持ち続けた場合(HODL)の評価額。負なら損。 */
export function impermanentLoss({ x, y, x0, y0, Px }) {
  const lp = x * Px + y;
  const hodl = x0 * Px + y0;
  return { lp, hodl, il: lp - hodl };
}

/* ---------- σ(履歴) ---------- */

/**
 * history: [{t, pools: {"500": {p, flag?}}}]。
 * 直近30日の連続2点のうち 3h ≤ Δt ≤ 12h かつ非flag の組だけで RMS を取る。
 * σ_daily = sqrt(Σ r² / Σ Δt_days)(平均0)。
 */
export function computeSigma(history, now = Date.now(), poolKey = '500') {
  const windowMs = 30 * 24 * 3600 * 1000;
  const rows = (history || [])
    .map((e) => ({ t: Date.parse(e.t), p: e.pools?.[poolKey]?.p, flag: e.pools?.[poolKey]?.flag }))
    .filter((e) => Number.isFinite(e.t) && finitePos(e.p) && now - e.t <= windowMs)
    .sort((a, b) => a.t - b.t);
  let sumR2 = 0;
  let sumDt = 0;
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a.flag || b.flag) continue;
    const dtH = (b.t - a.t) / 3600000;
    if (dtH < 3 || dtH > 12) continue;
    const r = Math.log(b.p / a.p);
    sumR2 += r * r;
    sumDt += dtH / 24;
    n++;
  }
  const sigmaHist = n > 0 ? Math.sqrt(sumR2 / sumDt) : null;
  const lastT = rows.length ? rows[rows.length - 1].t : null;
  return {
    n,
    sigmaHist,
    provisional: n < MIN_SIGMA_SAMPLES,
    relError: n > 0 ? 1 / Math.sqrt(2 * n) : null,
    lastT,
    stale: lastT == null || now - lastT > 18 * 3600 * 1000,
  };
}

/** 縮小推定: σ² = (n·σ_hist² + 28·σ_default²)/(n+28)。履歴が無ければ既定値。 */
export function blendSigma({ n, sigmaHist }, sigmaDefault = DEFAULT_SIGMA) {
  if (!n || sigmaHist == null) return sigmaDefault;
  const m = MIN_SIGMA_SAMPLES;
  return Math.sqrt((n * sigmaHist ** 2 + m * sigmaDefault ** 2) / (n + m));
}

/* ---------- Cetus 応答の検証・抽出 ---------- */

/** stats_pools の応答から対象2プールを取り出す。不正なら Error を投げる(NaNを流さない)。 */
export function extractPools(json) {
  if (!json || json.code !== 0 && json.code !== 200) throw new Error('API応答のcodeが不正');
  const list = json?.data?.lp_list;
  if (!Array.isArray(list)) throw new Error('lp_list が配列ではない');
  const out = {};
  for (const [key, def] of Object.entries(POOLS)) {
    const p = list.find((x) => x.address === def.address);
    if (!p) continue;
    out[key] = parsePool(p, key);
  }
  return out;
}

export function parsePool(p, key) {
  const o = p.object || {};
  if (p.coin_a?.address !== USDC_TYPE) throw new Error('coin_a が USDC ではない');
  if (p.coin_b?.address !== SUI_TYPE) throw new Error('coin_b が SUI ではない');
  if (p.is_closed === true || o.is_pause === true) throw new Error('プールが停止/終了している');
  const pool = {
    key,
    feeRatePpm: Number(o.fee_rate),
    tickSpacing: Number(o.tick_spacing),
    liquidityHuman: poolLiquidityHuman(String(o.liquidity)),
    sqrtPrice: String(o.current_sqrt_price),
    tvl: Number(p.pure_tvl_in_usd),
    vol24h: Number(p.vol_in_usd_24h),
    fee24h: Number(p.fee_24_h),
    feeApr24h: Number(p.apr?.fee_apr_24h),
    rewarderAprs: (Array.isArray(p.rewarder_apr) ? p.rewarder_apr : []).map(parsePct),
  };
  pool.price = poolPrice(pool.sqrtPrice);
  for (const k of ['feeRatePpm', 'tickSpacing', 'liquidityHuman', 'tvl', 'price']) {
    if (!finitePos(pool[k])) throw new Error(`プール項目 ${k} が不正`);
  }
  if (!Number.isFinite(pool.vol24h) || pool.vol24h < 0) throw new Error('vol24h が不正');
  if (!Number.isFinite(pool.fee24h) || pool.fee24h < 0) throw new Error('fee24h が不正');
  if (!pool.rewarderAprs.every(Number.isFinite)) throw new Error('rewarder_apr が不正');
  if (!Number.isFinite(pool.feeApr24h)) pool.feeApr24h = null;
  return pool;
}

/** history.json 用の1エントリ。不正なプールは省き、全て不正なら null。 */
export function buildHistoryEntry(pools, nowIso) {
  const entry = { t: nowIso, pools: {} };
  const keys = Object.keys(pools);
  for (const k of keys) {
    const q = pools[k];
    if (![q.price, q.tvl].every(finitePos)) continue;
    if (!Number.isFinite(q.vol24h) || !Number.isFinite(q.fee24h)) continue;
    entry.pools[k] = {
      p: Number(q.price.toPrecision(8)),
      tvl: Math.round(q.tvl),
      vol24h: Math.round(q.vol24h),
      fee24h: Math.round(q.fee24h * 100) / 100,
    };
  }
  if (Object.keys(entry.pools).length === 0) return null;
  const a = entry.pools['500']?.p;
  const b = entry.pools['2500']?.p;
  if (a && b && Math.abs(a / b - 1) > 0.01) {
    for (const k of Object.keys(entry.pools)) entry.pools[k].flag = true;
  }
  return entry;
}

export function appendHistory(history, entry) {
  const next = [...(Array.isArray(history) ? history : []), entry];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/** 履歴から直近 days 日の出来高平均。サンプルが期待数の75%未満なら null。 */
export function averageVolume(history, days, poolKey, now = Date.now(), samplesPerDay = 4) {
  const from = now - days * 24 * 3600 * 1000;
  const vals = (history || [])
    .filter((e) => Date.parse(e.t) >= from && Number.isFinite(e.pools?.[poolKey]?.vol24h))
    .map((e) => e.pools[poolKey].vol24h);
  if (vals.length < days * samplesPerDay * 0.75) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/* ---------- 表示整形 ---------- */

export const fmtUsd = (v, d = 2) =>
  Number.isFinite(v) ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
export const fmtPct = (v, d = 1) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '—');
export const fmtNum = (v, d = 2) =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
