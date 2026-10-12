import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../calc.mjs';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

/* ---- パーサ・価格 ---- */
test('parsePct', () => {
  assert.equal(C.parsePct('13.76%'), 0.1376);
  assert.equal(C.parsePct('0.6695'), 0.6695);
  assert.equal(C.parsePct('0%'), 0);
  assert.equal(C.parsePct(0.5), 0.5);
});

test('fee_rate ppm → 小数', () => {
  assert.equal(500 / 1e6, 0.0005);
});

test('poolPrice: 実測 sqrtPrice', () => {
  close(C.poolPrice('550522647565590732342'), 1.1228, 0.0005);
  // BigInt同士の整数除算(旧バグ)なら約 1.19 になる
  assert.ok(C.poolPrice('550522647565590732342') < 1.2);
});

test('poolLiquidityHuman: 10^7.5 換算', () => {
  close(C.poolLiquidityHuman('478058386611643'), 478058386611643 / 10 ** 7.5, 1);
});

/* ---- 正規分布 ---- */
test('normCdf 既知値', () => {
  close(C.normCdf(0), 0.5, 1e-14);
  close(C.normCdf(1), 0.8413447460685429, 1e-12);
  close(C.normCdf(-1.96), 0.024997895148220435, 1e-12);
  close(C.normCdf(3), 0.9986501019683699, 1e-12);
  close(C.normCdf(-5), 2.866515718791939e-7, 1e-15);
  close(C.normCdf(8), 1, 1e-14);
});

/* ---- CLMM ---- */
test('L と数量の整合: x·P + y = V', () => {
  const P = 1.1228, Pa = P * 0.9, Pb = P * 1.1, V = 1000;
  const L = C.clmmLiquidity(P, Pa, Pb, V);
  const { x, y } = C.amountsAt(L, P, Pa, Pb);
  close(x * P + y, V, 1e-9);
  close(C.liquidityFromAmounts(x, y, P, Pa, Pb), L, 1e-9);
});

test('全範囲極限 L = V/(2√P)', () => {
  const P = 1.12, V = 1000;
  const L = C.clmmLiquidity(P, 1e-20, 1e20, V);
  assert.ok(rel(L, V / (2 * Math.sqrt(P))) < 1e-6);
});

test('liquidityFromAmounts: レンジ外・不整合', () => {
  const Pa = 1, Pb = 2;
  assert.equal(C.liquidityFromAmounts(0, 5, 1.5, Pa, Pb), null);
  assert.equal(C.liquidityFromAmounts(5, 0, 1.5, Pa, Pb), null);
  // 価格が下限以下: SUI のみ
  const L = C.liquidityFromAmounts(10, 0, 0.9, Pa, Pb);
  close(C.amountsAt(L, 0.9, Pa, Pb).x, 10, 1e-9);
  // 価格が上限以上: USDC のみ
  const L2 = C.liquidityFromAmounts(0, 10, 2.1, Pa, Pb);
  close(C.amountsAt(L2, 2.1, Pa, Pb).y, 10, 1e-9);
});

test('IL: 端点の数量', () => {
  const P = 1.1, Pa = 1.0, Pb = 1.2, L = 100;
  const lo = C.amountsAt(L, 0.5, Pa, Pb);
  close(lo.x, L * (1 / Math.sqrt(Pa) - 1 / Math.sqrt(Pb)), 1e-12);
  assert.equal(lo.y, 0);
  const hi = C.amountsAt(L, 5, Pa, Pb);
  assert.equal(hi.x, 0);
  close(hi.y, L * (Math.sqrt(Pb) - Math.sqrt(Pa)), 1e-12);
  // 現在価格では IL = 0
  const cur = C.amountsAt(L, P, Pa, Pb);
  const r = C.impermanentLoss({ ...cur, x0: cur.x, y0: cur.y, Px: P });
  close(r.il, 0, 1e-9);
  // 価格が動くと LP は HODL より劣後(IL < 0)
  const up = C.amountsAt(L, 1.15, Pa, Pb);
  assert.ok(C.impermanentLoss({ ...up, x0: cur.x, y0: cur.y, Px: 1.15 }).il < 0);
});

test('資本効率倍率: 狭いほど大きい / 全範囲で1', () => {
  const P = 1.12;
  const e5 = C.capitalEfficiency(P, P * 0.95, P * 1.05);
  const e50 = C.capitalEfficiency(P, P * 0.5, P * 1.5);
  assert.ok(e5 > e50 && e50 > 1);
  close(C.capitalEfficiency(P, 1e-12, 1e12), 1, 1e-5);
});

/* ---- tick ---- */
test('tick 往復(誤差1e-9)', () => {
  for (const P of [0.5, 1.0, 1.1228, 3.3]) {
    close(C.tickToUsd(C.usdToTick(P)) / P, 1, 1e-9);
  }
  // 実測: 0.05% プールの現在 tick ≈ 67923
  close(C.usdToTick(1.1228), 67923, 15);
});

test('tickRange: 最近傍丸め・順序・間隔', () => {
  const P = 1.1228;
  for (const [r, sp] of [[0.05, 10], [0.05, 60], [0.5, 60]]) {
    const t = C.tickRange(P, r, sp);
    assert.ok(t.tickLower < t.tickUpper);
    assert.equal(t.tickLower % sp, 0);
    assert.equal(t.tickUpper % sp, 0);
    assert.ok(t.Pa < P && P < t.Pb);
    // 丸めによるずれは spacing 1つ分(約 sp bp)以内
    close(t.Pa / (P * (1 - r)), 1, sp * 1.1e-4);
    close(t.Pb / (P * (1 + r)), 1, sp * 1.1e-4);
  }
  // 最近傍丸めなので下限・上限のずれが同方向に偏らない(floor だと上限が常に広がる)
  const t = C.tickRange(P, 0.05, 60);
  const dLo = Math.abs(t.Pa / (P * 0.95) - 1);
  const dHi = Math.abs(t.Pb / (P * 1.05) - 1);
  assert.ok(dLo <= 60 * 0.5e-4 + 1e-4 && dHi <= 60 * 0.5e-4 + 1e-4);
});

test('tickRange: 同値になる極狭レンジは1 spacing 広げる', () => {
  const t = C.tickRangeFromPrices(1.1228, 1.1228, 60);
  assert.ok(t.tickLower < t.tickUpper);
});

/* ---- 確率 ---- */
test('離脱確率: 参照値', () => {
  const P = 1.12, s = 0.0595;
  close(C.exitProbability(P, P * 0.9, P * 1.1, s), 0.94, 0.03);
  close(C.exitProbability(P, P * 0.85, P * 1.15, s), 0.67, 0.03);
  assert.ok(C.exitProbability(P, P * 0.5, P * 1.5, s) < 0.02);
});

test('離脱確率: 広義単調 / 高σでも収束', () => {
  const P = 1.12, s = 0.0595;
  let prev = 2;
  for (const r of C.RANGES) {
    const v = C.exitProbability(P, P * (1 - r), P * (1 + r), s);
    assert.ok(v <= prev + 1e-12, `r=${r}`);
    assert.ok(v >= 0 && v <= 1);
    prev = v;
  }
  const stay = C.stayProbability(P, P * 0.95, P * 1.05, 0.2);
  assert.ok(stay < 1e-6, `stay=${stay}`);
});

test('離脱確率: モンテカルロと概ね一致', () => {
  const P = 1, s = 0.0595, a = 0.85, b = 1.15, steps = 7 * 96;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  let exits = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    let x = 0;
    for (let j = 0; j < steps; j++) {
      x += gauss() * s * Math.sqrt(1 / 96);
      const px = Math.exp(x);
      if (px <= a || px >= b) { exits++; break; }
    }
  }
  const theory = C.exitProbability(P, a, b, s);
  close(exits / N, theory, 0.05);
});

test('期待滞在率: 範囲が広いほど大きく [0,1]', () => {
  const P = 1.12, s = 0.0595;
  const v5 = C.expectedStay(P, P * 0.95, P * 1.05, s);
  const v10 = C.expectedStay(P, P * 0.9, P * 1.1, s);
  const v50 = C.expectedStay(P, P * 0.5, P * 1.5, s);
  assert.ok(v5 > 0 && v5 < v10 && v10 < v50 && v50 <= 1);
  close(v50, 1, 0.01);
});

/* ---- 手数料 ---- */
const pool = {
  feeRatePpm: 500,
  liquidityHuman: 478058386611643 / 10 ** 7.5,
  tvl: 1047323,
  vol24h: 3860881,
  rewarderAprs: [0.1387, 0, 0, 0, 0],
};

test('rangeFee: プール平均比の理論値と一致(相対誤差1e-9)', () => {
  const P = 1.1228, V = 1000, sigma = 0.0595;
  for (const r of C.RANGES) {
    const Pa = P * (1 - r), Pb = P * (1 + r);
    const row = C.rangeFee({ P, Pa, Pb, V, pool, sigma });
    const L = row.L;
    const theory = (row.capEff / row.concentration) * row.stay * (pool.liquidityHuman / (pool.liquidityHuman + L));
    assert.ok(rel(row.poolAvgRatio, theory) < 1e-9, `r=${r}`);
  }
});

test('rangeFee: 狭いほど資本効率と日次手数料が大きい / シェアは V/TVL より小さい', () => {
  const P = 1.1228, V = 1000, sigma = 0.0595;
  const rows = C.RANGES.map((r) => C.rangeFee({ P, Pa: P * (1 - r), Pb: P * (1 + r), V, pool, sigma, stay: 1 }));
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].capEff < rows[i - 1].capEff);
    assert.ok(rows[i].dailyFee < rows[i - 1].dailyFee);
  }
  const full = C.rangeFee({ P, Pa: 1e-9, Pb: 1e9, V, pool, sigma, stay: 1 });
  assert.ok(full.share < V / pool.tvl);
});

test('rangeFee: LP取り分(protocol fee 控除)', () => {
  const P = 1.1228, V = 1000;
  const a = C.rangeFee({ P, Pa: P * 0.9, Pb: P * 1.1, V, pool, stay: 1, pf: 0 });
  const b = C.rangeFee({ P, Pa: P * 0.9, Pb: P * 1.1, V, pool, stay: 1, pf: 0.2 });
  close(b.dailyFee / a.dailyFee, 0.8, 1e-12);
});

/* ---- σ ---- */
function synth({ n, sigmaDaily, stepH = 6, jitterH = 0, drop = [], start = Date.parse('2026-09-01T00:00:00Z'), flagAt = [] }) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const out = [];
  let p = 1.1;
  for (let i = 0; i <= n; i++) {
    if (i > 0) p *= Math.exp(gauss() * sigmaDaily * Math.sqrt(stepH / 24));
    if (drop.includes(i)) continue;
    const t = start + i * stepH * 3600000 + (i % 3 === 1 ? jitterH * 3600000 : 0);
    out.push({ t: new Date(t).toISOString(), pools: { 500: { p, ...(flagAt.includes(i) ? { flag: true } : {}) } } });
  }
  return out;
}
const NOW = Date.parse('2026-10-01T00:00:00Z');

test('computeSigma: 合成GBM(σ=5%/日, n=120)で±15%以内', () => {
  const h = synth({ n: 120, sigmaDaily: 0.05 });
  const r = C.computeSigma(h, NOW);
  assert.equal(r.provisional, false);
  assert.ok(Math.abs(r.sigmaHist / 0.05 - 1) < 0.15, `sigma=${r.sigmaHist}`);
});

test('computeSigma: 欠落(12h)・遅延(約47分)でもほぼ不変', () => {
  const base = C.computeSigma(synth({ n: 120, sigmaDaily: 0.05 }), NOW).sigmaHist;
  const gap = C.computeSigma(synth({ n: 120, sigmaDaily: 0.05, drop: [30, 70] }), NOW).sigmaHist;
  const late = C.computeSigma(synth({ n: 120, sigmaDaily: 0.05, jitterH: 0.78 }), NOW).sigmaHist;
  assert.ok(Math.abs(gap / base - 1) < 0.1, `gap ${gap} base ${base}`);
  assert.ok(Math.abs(late / base - 1) < 0.15, `late ${late} base ${base}`);
});

test('computeSigma: Δt>12h の組は除外される', () => {
  const h = synth({ n: 10, sigmaDaily: 0.05, stepH: 24 });
  const r = C.computeSigma(h, NOW);
  assert.equal(r.n, 0);
  assert.equal(r.sigmaHist, null);
});

test('computeSigma: 有効27本は暫定値、28本は履歴由来', () => {
  assert.equal(C.computeSigma(synth({ n: 27, sigmaDaily: 0.05 }), NOW).provisional, true);
  assert.equal(C.computeSigma(synth({ n: 27, sigmaDaily: 0.05 }), NOW).n, 27);
  assert.equal(C.computeSigma(synth({ n: 28, sigmaDaily: 0.05 }), NOW).provisional, false);
});

test('computeSigma: flag付きは除外 / 30日より古いデータは使わない', () => {
  const r = C.computeSigma(synth({ n: 40, sigmaDaily: 0.05, flagAt: [10] }), NOW);
  assert.equal(r.n, 38); // flagの両隣の2組が落ちる
  const old = C.computeSigma(synth({ n: 40, sigmaDaily: 0.05, start: Date.parse('2026-06-01T00:00:00Z') }), NOW);
  assert.equal(old.n, 0);
  assert.equal(old.stale, true);
});

test('blendSigma: 履歴なしは既定値、多いほど履歴に近づく', () => {
  assert.equal(C.blendSigma({ n: 0, sigmaHist: null }), C.DEFAULT_SIGMA);
  const s = C.blendSigma({ n: 1000, sigmaHist: 0.1 });
  assert.ok(s > 0.095 && s < 0.1);
});

/* ---- Cetus 応答・履歴 ---- */
const sample = (over = {}) => ({
  code: 0,
  data: {
    lp_list: [
      {
        address: C.POOLS[500].address,
        coin_a: { address: C.USDC_TYPE },
        coin_b: { address: C.SUI_TYPE },
        is_closed: false,
        price: '1.3894160571378011', // 使わないこと
        pure_tvl_in_usd: '1047323.64',
        vol_in_usd_24h: '3860881.43',
        fee_24_h: '1930.44',
        apr: { fee_apr_24h: '0.6683' },
        rewarder_apr: ['13.8672%', '0%', '0%', '0%', '0%'],
        object: {
          fee_rate: 500,
          tick_spacing: 10,
          liquidity: '478058386611643',
          current_sqrt_price: '550522647565590732342',
          is_pause: false,
        },
        ...over,
      },
    ],
  },
});

test('extractPools: 正常系はプール価格を使い API の price を使わない', () => {
  const pools = C.extractPools(sample());
  close(pools[500].price, 1.1228, 0.0005);
  assert.equal(pools[500].feeRatePpm, 500);
  close(pools[500].rewarderAprs[0], 0.138672, 1e-9);
});

test('extractPools: 不正値は例外(NaNを流さない)', () => {
  assert.throws(() => C.extractPools({ code: 500 }));
  assert.throws(() => C.extractPools({ code: 0, data: {} }));
  assert.throws(() => C.extractPools(sample({ pure_tvl_in_usd: 'abc' })));
  assert.throws(() => C.extractPools(sample({ coin_a: { address: '0x1::x::X' } })));
  assert.throws(() => C.extractPools(sample({ is_closed: true })));
});

test('buildHistoryEntry: 不正値は省く / 全て不正なら null / 乖離>1%でflag', () => {
  const ok = { price: 1.12, tvl: 1e6, vol24h: 3e6, fee24h: 1500 };
  assert.deepEqual(Object.keys(C.buildHistoryEntry({ 500: ok, 2500: { ...ok, price: NaN } }, 'x').pools), ['500']);
  assert.equal(C.buildHistoryEntry({ 500: { ...ok, price: NaN }, 2500: { ...ok, tvl: 0 } }, 'x'), null);
  const e = C.buildHistoryEntry({ 500: ok, 2500: { ...ok, price: 1.14 } }, 'x');
  assert.equal(e.pools[500].flag, true);
  const e2 = C.buildHistoryEntry({ 500: ok, 2500: { ...ok, price: 1.121 } }, 'x');
  assert.equal(e2.pools[500].flag, undefined);
});

test('appendHistory: 上限でトリム', () => {
  const h = Array.from({ length: C.HISTORY_LIMIT }, (_, i) => ({ t: String(i), pools: {} }));
  const n = C.appendHistory(h, { t: 'new', pools: {} });
  assert.equal(n.length, C.HISTORY_LIMIT);
  assert.equal(n[n.length - 1].t, 'new');
  assert.equal(n[0].t, '1');
});

test('averageVolume: サンプル不足なら null', () => {
  const now = Date.parse('2026-10-10T00:00:00Z');
  const few = [{ t: '2026-10-09T00:00:00Z', pools: { 500: { vol24h: 1 } } }];
  assert.equal(C.averageVolume(few, 7, '500', now), null);
  const many = Array.from({ length: 28 }, (_, i) => ({
    t: new Date(now - i * 6 * 3600000).toISOString(),
    pools: { 500: { vol24h: 100 } },
  }));
  assert.equal(C.averageVolume(many, 7, '500', now), 100);
});
