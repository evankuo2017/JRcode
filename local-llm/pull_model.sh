#!/usr/bin/env bash
# 下載 Qwen3-Coder-30B（約 19GB，存到本資料夾 models/）
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/env.sh"
ollama pull qwen3-coder:30b
