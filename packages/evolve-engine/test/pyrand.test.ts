// pyrand 保真:Python 3.12 `random.Random(seed)` 真值向量对照(生成脚本见任务 5.2 记录)。
// 向量覆盖 golden 四例种子、边缘种子(0/1/2^32/2^32+1/2^48-1)、shuffle(n=3/4/5/8)、
// getrandbits 序列、randbelow(3) —— 全部来自 CPython stdlib 实测,期望值内嵌不依赖外部文件。
import assert from "node:assert/strict";
import test from "node:test";

import { PyRandom, pyBitLength } from "../src/pyrand.js";

test("pyBitLength: Python int.bit_length", () => {
  assert.equal(pyBitLength(0), 0);
  assert.equal(pyBitLength(1), 1);
  assert.equal(pyBitLength(2), 2);
  assert.equal(pyBitLength(3), 2);
  assert.equal(pyBitLength(4), 3);
  assert.equal(pyBitLength(2 ** 32), 33);
});

test("shuffle golden 四例:assign_ids 的种子与洗牌结果与 Python 一致", () => {
  const cases: Array<{ seed: number; sorted: string[]; want: string[] }> = [
    { seed: 209986752902967, sorted: ["c1", "c2"], want: ["c1", "c2"] },
    { seed: 120398865327534, sorted: ["agg1", "agg2"], want: ["agg1", "agg2"] },
    { seed: 111529702941339, sorted: ["c1", "c2"], want: ["c2", "c1"] },
    { seed: 188582326541259, sorted: ["agg1", "agg2"], want: ["agg2", "agg1"] },
  ];
  for (const c of cases) {
    const x = [...c.sorted];
    new PyRandom(c.seed).shuffle(x);
    assert.deepEqual(x, c.want, `seed ${c.seed}`);
  }
});

test("shuffle 向量:n=3/4/5/8 × 边缘种子,与 Python random.Random(seed).shuffle 逐元素一致", () => {
  const vectors: Array<[string, number[]]> = [
    ["n3-seed0", [0, 2, 1]],
    ["n3-seed1", [1, 2, 0]],
    ["n3-seed2^32", [2, 1, 0]],
    ["n3-seed2^32+1", [2, 1, 0]],
    ["n3-seed2^48-1", [2, 0, 1]],
    ["n3-seed63810103221111", [2, 1, 0]],
    ["n4-seed0", [2, 0, 1, 3]],
    ["n4-seed1", [3, 0, 2, 1]],
    ["n4-seed2^32", [3, 2, 1, 0]],
    ["n4-seed2^32+1", [0, 3, 2, 1]],
    ["n4-seed2^48-1", [1, 0, 2, 3]],
    ["n4-seed159239111605757", [0, 1, 3, 2]],
    ["n5-seed0", [2, 1, 0, 4, 3]],
    ["n5-seed1", [2, 3, 4, 0, 1]],
    ["n5-seed2^32", [3, 4, 1, 2, 0]],
    ["n5-seed2^32+1", [2, 4, 0, 3, 1]],
    ["n5-seed2^48-1", [4, 2, 1, 0, 3]],
    ["n5-seed41992386607792", [3, 2, 4, 1, 0]],
    ["n8-seed0", [4, 1, 5, 2, 0, 3, 7, 6]],
    ["n8-seed1", [3, 6, 1, 5, 7, 0, 4, 2]],
    ["n8-seed2^32", [5, 7, 6, 4, 0, 3, 2, 1]],
    ["n8-seed2^32+1", [2, 5, 1, 0, 7, 6, 4, 3]],
    ["n8-seed2^48-1", [5, 1, 6, 3, 2, 0, 4, 7]],
    ["n8-seed784217420566", [1, 2, 7, 3, 0, 5, 6, 4]],
  ];
  const seeds: Record<string, number> = {
    "seed0": 0,
    "seed1": 1,
    "seed2^32": 2 ** 32,
    "seed2^32+1": 2 ** 32 + 1,
    "seed2^48-1": 2 ** 48 - 1,
    "seed63810103221111": 63810103221111,
    "seed159239111605757": 159239111605757,
    "seed41992386607792": 41992386607792,
    "seed784217420566": 784217420566,
  };
  for (const [name, want] of vectors) {
    const m = /^n(\d+)-(.+)$/.exec(name)!;
    const n = Number(m[1]);
    const seed = seeds[m[2]];
    const x = Array.from({ length: n }, (_, i) => i);
    new PyRandom(seed).shuffle(x);
    assert.deepEqual(x, want, name);
  }
});

test("getrandbits 序列:32/1/5/31 位混抽,与 Python 逐个一致", () => {
  const cases: Array<[number, number[]]> = [
    [0, [3626764237, 1654615998, 3255389356, 3823568514, 0, 1, 556019485]],
    [1, [577090037, 2444712010, 3639700191, 3445702192, 1, 2, 547756574]],
    [2 ** 32, [485306839, 1508871100, 1794561286, 4014597330, 0, 0, 1313661828]],
    [209986752902967, [2945295006, 1078720986, 583687294, 1661998732, 1, 10, 1512509161]],
  ];
  for (const [seed, want] of cases) {
    const r = new PyRandom(seed);
    const got = [
      r.getrandbits(32),
      r.getrandbits(32),
      r.getrandbits(32),
      r.getrandbits(32),
      r.getrandbits(1),
      r.getrandbits(5),
      r.getrandbits(31),
    ];
    assert.deepEqual(got, want, `seed ${seed}`);
  }
});

test("randbelow(3)×10:拒绝采样路径与 Python 一致", () => {
  const r0 = new PyRandom(0);
  assert.deepEqual(
    Array.from({ length: 10 }, () => r0.randbelow(3)),
    [1, 1, 0, 1, 2, 1, 1, 1, 1, 1],
  );
  const r1 = new PyRandom(1);
  assert.deepEqual(
    Array.from({ length: 10 }, () => r1.randbelow(3)),
    [0, 2, 0, 1, 0, 1, 1, 1, 2, 1],
  );
});

test("randbelow(1) 恒 0;负种子/非整数种子抛 RangeError", () => {
  const r = new PyRandom(123);
  for (let i = 0; i < 5; i++) assert.equal(r.randbelow(1), 0);
  assert.throws(() => new PyRandom(-1), RangeError);
  assert.throws(() => new PyRandom(1.5), RangeError);
});

// CPython random.seed(str, version=2) 路径:a = s.encode('utf-8');
// x = int.from_bytes(a + sha512(a).digest(), 'big') 再走 int 字组路径。
// 真值向量由 CPython 3.x 实测生成(schedule.stream_order 的 `${seed}:__domains__` /
// `${seed}:${domain}` 种子形态)。
test("str 种子 shuffle 向量:CPython seed(version=2) 语义逐元素一致", () => {
  const base = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  const cases: Array<[string, string[]]> = [
    ["0:__domains__", ["alpha", "zeta", "gamma", "epsilon", "delta", "beta"]],
    ["0:accounting", ["gamma", "alpha", "delta", "epsilon", "beta", "zeta"]],
    ["0:", ["gamma", "delta", "beta", "alpha", "epsilon", "zeta"]],
    ["1:__domains__", ["gamma", "delta", "alpha", "zeta", "epsilon", "beta"]],
    ["1:accounting", ["zeta", "gamma", "beta", "alpha", "delta", "epsilon"]],
    ["1:", ["delta", "epsilon", "zeta", "alpha", "gamma", "beta"]],
    ["7:__domains__", ["zeta", "epsilon", "beta", "delta", "gamma", "alpha"]],
    ["7:accounting", ["zeta", "alpha", "gamma", "epsilon", "delta", "beta"]],
    ["7:", ["beta", "gamma", "zeta", "epsilon", "alpha", "delta"]],
    ["42:__domains__", ["zeta", "gamma", "delta", "alpha", "beta", "epsilon"]],
    ["42:accounting", ["delta", "epsilon", "zeta", "beta", "alpha", "gamma"]],
    ["42:", ["gamma", "delta", "epsilon", "beta", "zeta", "alpha"]],
  ];
  for (const [seed, want] of cases) {
    const x = [...base];
    new PyRandom(seed).shuffle(x);
    assert.deepEqual(x, want, `str seed ${JSON.stringify(seed)}`);
  }
});

test("str 种子与 int 种子路径分流:Random(7) 不受 str 语义影响", () => {
  const x = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  new PyRandom(7).shuffle(x);
  assert.deepEqual(x, ["epsilon", "alpha", "zeta", "delta", "beta", "gamma"]);
});
