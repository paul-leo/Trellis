/**
 * secrets 擦除(trellis-evolve 任务 11.1)。
 *
 * 信号写入前,所有字符串字段经此擦除(11.2 的用户纠正文本同样如此)。
 * 模式取已知凭据形态:API token 前缀、Bearer 头、key=value 凭据赋值、
 * PEM 私钥块。不承诺穷尽 —— 主防线是事件层根本不收载荷,这里是纵深。
 */

const PATTERNS: Array<[RegExp, string]> = [
  // OpenAI / Anthropic 风格:sk-...、sk-ant-...
  [/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  // GitHub token:ghp_/gho_/ghs_/ghr_/github_pat_
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  // AWS access key id
  [/AKIA[0-9A-Z]{12,}/g, "[REDACTED]"],
  // JWT(三段 base64url,header 恒以 eyJ 开头)
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  // Slack token:xoxb/xoxp/xoxa/xoxs/xoxr
  [/xox[bpasr]-[A-Za-z0-9-]{8,}/g, "[REDACTED]"],
  // Bearer 头
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [REDACTED]"],
  // key=value / key: value 凭据赋值形态(值若是 Bearer/Basic 头留给上面
  // 的 Bearer 规则处理,避免只吃掉 scheme 词、漏掉真实 token)。
  [
    /((?:api[_-]?key|apikey|token|secret|password|passwd|credential|authorization|access[_-]?key)["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic|Token)\b)[^\s"'&;,]{4,}/gi,
    "$1[REDACTED]",
  ],
  // PEM 私钥块
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]"],
];

/** 对单个字符串字段做 secrets 擦除;非敏感内容原样保留。 */
export function eraseSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** 对记录中所有字符串值递归擦除(载荷级防御)。 */
export function eraseSecretsDeep(value: unknown): unknown {
  if (typeof value === "string") return eraseSecrets(value);
  if (Array.isArray(value)) return value.map(eraseSecretsDeep);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = eraseSecretsDeep(v);
    return out;
  }
  return value;
}

/** `${VAR}` 引用(workspace 可提交约束明确允许)。 */
const VAR_REF = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g;

/**
 * 凭据形态**字面值**检测(12.2 的 workspace 可提交约束):先把
 * `${VAR}` 引用挖掉(合法引用不算字面值),再用与擦除同源的凭据形态
 * 模式判定剩余文本。命中即 true —— 只认形态,不承诺穷尽。
 */
export function containsCredentialLiteral(text: string): boolean {
  const withoutRefs = text.replace(VAR_REF, "");
  return PATTERNS.some(([pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(withoutRefs);
  });
}
