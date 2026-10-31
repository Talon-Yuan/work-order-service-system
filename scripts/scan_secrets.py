#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
密钥残留扫描脚本（安全红线一：前端零密钥）
用法: python scripts/scan_secrets.py [project_root]
扫描项目目录下所有文本文件，命中疑似密钥/凭据模式即告警。
退出码: 0=通过(无残留)  1=发现残留  2=执行异常
"""
import os
import re
import sys

PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
) if len(sys.argv) < 2 else os.path.abspath(sys.argv[1])

# 排除目录
EXCLUDE_DIRS = {".git", ".svn", "node_modules", "temp", "output", "__pycache__"}
# 二进制/不扫描扩展名
BINARY_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2",
               ".ttf", ".otf", ".mp4", ".zip", ".rar", ".7z", ".exe", ".dll", ".db"}
# 模板占位符（env-template 中的示例不算真实残留）
PLACEHOLDER_OK = re.compile(r"(__YOUR_[A-Z_]+__|<[A-Z_]+>|your_[a-z_]+|xxx|example\.com)", re.I)

# 疑似密钥模式
PATTERNS = [
    (re.compile(r"\bAKID[A-Za-z0-9]{10,}\b", re.I), "腾讯云 AccessKeyId"),
    (re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"), "私钥块"),
    (re.compile(r"\bsk-[A-Za-z0-9]{16,}\b"), "sk- 风格密钥(OpenAI 等)"),
    (re.compile(r"(?i)\b(api[_-]?key|secret[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*['\"][A-Za-z0-9_\-]{16,}['\"]"), "API Key 赋值"),
    (re.compile(r"(?i)\b(password|passwd|pwd)\s*[:=]\s*['\"][^\s'\"]{6,}['\"]"), "明文密码赋值"),
    (re.compile(r"(?i)\b(token|access_token|jwt|bearer)\s*[:=]\s*['\"][A-Za-z0-9._\-]{20,}['\"]"), "疑似 Token 硬编码"),
    (re.compile(r"(?i)\bsession_key\s*[:=]\s*['\"][^\s'\"]{10,}['\"]"), "微信 session_key"),
    (re.compile(r"(?i)mysql://[^\s'\"@]+:[^\s'\"@]+@"), "数据库连接串含密码"),
    (re.compile(r"(?i)redis://[^\s'\"@]+:[^\s'\"@]+@"), "Redis 连接串含密码"),
]

def iter_text_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if ext in BINARY_EXTS:
                continue
            yield os.path.join(dirpath, name)

def scan():
    hits = []
    for fp in iter_text_files(PROJECT_ROOT):
        try:
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except Exception as e:  # noqa: BLE001
            hits.append((fp, 0, "读取失败: %s" % e))
            continue
        # 模板/文档占位文件整体跳过样例行
        for lineno, line in enumerate(content.splitlines(), 1):
            if PLACEHOLDER_OK.search(line):
                continue
            for rx, label in PATTERNS:
                m = rx.search(line)
                if m:
                    snippet = line.strip()
                    if len(snippet) > 120:
                        snippet = snippet[:120] + "..."
                    hits.append((fp, lineno, "%s: %s" % (label, snippet)))
                    break  # 每行只报第一个命中
    return hits

def main():
    print("== 密钥残留扫描 ==")
    print("扫描根目录: %s" % PROJECT_ROOT)
    hits = scan()
    if not hits:
        print("通过: 未发现疑似密钥残留。")
        return 0
    print("发现 %d 处疑似残留（请人工复核，模板占位符已豁免）:" % len(hits))
    for fp, lineno, msg in hits:
        rel = os.path.relpath(fp, PROJECT_ROOT)
        print("  - %s:%d  %s" % (rel, lineno, msg))
    return 1

if __name__ == "__main__":
    sys.exit(main())
