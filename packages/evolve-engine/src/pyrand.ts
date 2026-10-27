// pyrand.ts — Python `random.Random(非负 int 种子)` 语义的最小移植,只为 selection 的
// 确定性 id_map 服务。与 harness2 的对照点:
//   init_by_array     ↔ CPython _randommodule.c init_by_array(注意:第二遍混合乘数是
//                       CPython 的 1566083941,不是 MT19937 参考实现的 5674839)
//   genrand → getrandbits(k) ↔ CPython getrandbits(k≤32) = genrand_uint32() >> (32-k)
//   randbelow(n)      ↔ Python Random._randbelow_with_getrandbits(bit_length 拒绝采样)
//   shuffle(x)        ↔ Python 3.11+ Random.shuffle:for i = n-1..1: j = randbelow(i+1)
//   str 种子          ↔ CPython random.seed(str, version=2):
//                        a = s.encode('utf-8'); x = int.from_bytes(a + sha512(a).digest(), 'big')
//                        再走 int 路径(小端 32 位字组 → init_by_array)。schedule.stream_order
//                        的 `Random(f"{seed}:__domains__")` / `Random(f"{seed}:{d}")` 依赖此路径。
// 32 位运算一律 >>> 0 归一;乘法用 Math.imul 取低 32 位(与 C uint32 环绕一致)。
// 数字种子只支持非负安全整数(harness2 侧种子来自 sha1 十六进制前 12 位,恒非负);
// 负种子在 CPython 走另一条 abs 分支,这里显式拒绝而不是猜。
import { createHash } from "node:crypto";

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

/** Python int.bit_length()(非负整数)。 */
export function pyBitLength(n: number): number {
  if (n <= 0) return 0;
  return Math.floor(Math.log2(n)) + 1;
}

/** 种子 → init_by_array 的 key 字:小端 32 位字组;0 → [0](CPython keyused≥1)。 */
function seedWords(seed: number): number[] {
  const words: number[] = [];
  let n = seed;
  while (n > 0) {
    words.push(n % 0x1_0000_0000);
    n = Math.floor(n / 0x1_0000_0000);
  }
  return words.length ? words : [0];
}

/**
 * CPython `random.seed(str, version=2)`:a = s.encode('utf-8');
 * x = int.from_bytes(a + sha512(a).digest(), 'big');再走 int 的小端字组路径。
 * 空串也会经 sha512 展宽,恒非空。
 */
function seedWordsFromStr(s: string): number[] {
  const a = Buffer.from(s, "utf8");
  const combined = Buffer.concat([a, createHash("sha512").update(a).digest()]);
  let x = 0n;
  for (const b of combined) {
    x = (x << 8n) | BigInt(b);
  }
  const words: number[] = [];
  while (x > 0n) {
    words.push(Number(x & 0xffffffffn));
    x >>= 32n;
  }
  return words.length ? words : [0];
}

/** CPython `random.Random(seed)` 的状态机(种子 → MT19937 → getrandbits/randbelow/shuffle)。 */
export class PyRandom {
  private readonly state = new Uint32Array(N);
  private index = N;

  constructor(seed: number | string) {
    if (typeof seed === "string") {
      this.initByArray(seedWordsFromStr(seed));
      return;
    }
    if (!Number.isInteger(seed) || seed < 0) {
      throw new RangeError(`PyRandom seed must be a non-negative integer, got ${String(seed)}`);
    }
    const key = seedWords(seed);
    this.initByArray(key);
  }

  /** MT19937 init_genrand(s):index 置 N,首抽即触发 twist。 */
  private initGenrand(s: number): void {
    this.state[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      // 1812433253 * (mt[i-1] ^ (mt[i-1] >> 30)) + i,环到 32 位。
      const prev = this.state[i - 1];
      this.state[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.index = N;
  }

  /** CPython init_by_array:init_genrand(19650218) 后两轮混合。 */
  private initByArray(key: readonly number[]): void {
    this.initGenrand(19650218);
    const keyLength = key.length;
    let i = 1;
    let j = 0;
    let k = Math.max(N, keyLength);
    for (; k; k--) {
      const prev = this.state[i - 1];
      this.state[i] =
        ((this.state[i] ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        this.state[0] = this.state[N - 1];
        i = 1;
      }
      if (j >= keyLength) j = 0;
    }
    for (k = N - 1; k; k--) {
      const prev = this.state[i - 1];
      // 1566083941 是 CPython 自己的乘数(RDH 12/16/2002),与 MT19937 参考实现的
      // 5674839 不同 —— 对齐的是 Python random 模块,不是参考 C 代码。
      this.state[i] = ((this.state[i] ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        this.state[0] = this.state[N - 1];
        i = 1;
      }
    }
    this.state[0] = 0x80000000;
  }

  /** CPython genrand_uint32():twint + tempering,返回无符号 32 位。 */
  private genrand(): number {
    if (this.index >= N) {
      let kk: number;
      for (kk = 0; kk < N - M; kk++) {
        const y = (this.state[kk] & UPPER_MASK) | (this.state[kk + 1] & LOWER_MASK);
        this.state[kk] = (this.state[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      for (; kk < N - 1; kk++) {
        const y = (this.state[kk] & UPPER_MASK) | (this.state[kk + 1] & LOWER_MASK);
        this.state[kk] = (this.state[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      const y = (this.state[N - 1] & UPPER_MASK) | (this.state[0] & LOWER_MASK);
      this.state[N - 1] = (this.state[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      this.index = 0;
    }
    let y = this.state[this.index++];
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y = (y ^ (y >>> 18)) >>> 0;
    return y >>> 0;
  }

  /**
   * Python Random.getrandbits(k):k≤32 取一次 genrand 右移;k>32 拼字后右移废位;
   * k=0 返回 0 且不消耗状态。
   */
  getrandbits(k: number): number {
    if (k <= 0) return 0;
    if (k <= 32) return this.genrand() >>> (32 - k);
    // 字组装按小端:先抽的是低位字;整体右移废位(32*words - k)。
    const words = Math.floor((k - 1) / 32) + 1;
    let value = 0n;
    for (let i = 0; i < words; i++) {
      value |= BigInt(this.genrand()) << BigInt(32 * i);
    }
    return Number(value >> BigInt(32 * words - k));
  }

  /** Python Random._randbelow_with_getrandbits(n):bit_length + 拒绝采样。 */
  randbelow(n: number): number {
    const k = pyBitLength(n);
    let r = this.getrandbits(k);
    while (r >= n) {
      r = this.getrandbits(k);
    }
    return r;
  }

  /** Python 3.11+ Random.shuffle(x):原地交换,无 Fisher-Yates 偏移差异。 */
  shuffle<T>(x: T[]): void {
    for (let i = x.length - 1; i >= 1; i--) {
      const j = this.randbelow(i + 1);
      const tmp = x[i];
      x[i] = x[j];
      x[j] = tmp;
    }
  }
}
