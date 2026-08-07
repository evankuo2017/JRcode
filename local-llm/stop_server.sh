#!/usr/bin/env bash
# 關閉 Ollama 伺服器（安全：用 -x 精確比對程序名，不會誤殺 shell）
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/env.sh"
ollama stop qwen3-coder:30b 2>/dev/null   # 先卸載模型釋放 VRAM
pkill -x ollama 2>/dev/null && echo "已關閉 Ollama 伺服器" || echo "沒有在跑的 Ollama 伺服器"
