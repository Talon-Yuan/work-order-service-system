/**
 * rateLimit.js — 简单滑动窗口限流（云函数实例内存级）
 * 说明：内存限流仅覆盖单个实例维度，生产环境建议：
 *   - 使用数据库原子计数（counters 集合 + inc）做跨实例限流
 *   - 或接入网关级限流（如 API 网关 / 微信云开发安全规则）
 * 本实现用于骨架与演示，且为可选启用（authGuard 未显式传 rateKey 时跳过）。
 */
const WINDOW_MS = 60 * 1000; // 60 秒窗口
const MAX_HITS = 60;          // 默认每窗口 60 次

const buckets = new Map();    // key -> { windowStart, count }

function checkRateLimit(scope, identity, maxHits = MAX_HITS) {
  const key = `${scope}:${identity}`;
  const now = Date.now();
  const cur = buckets.get(key);
  if (!cur || now - cur.windowStart >= WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return { ok: true };
  }
  cur.count += 1;
  if (cur.count > maxHits) {
    return { ok: false, retryAfterSec: Math.ceil((cur.windowStart + WINDOW_MS - now) / 1000) };
  }
  return { ok: true };
}

module.exports = { checkRateLimit };
