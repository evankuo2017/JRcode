#!/usr/bin/env bash
# 啟動 Ollama 服務（前景執行；要背景可加 nohup ... &）
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/env.sh"
echo "OLLAMA_MODELS = $OLLAMA_MODELS"
echo "監聽於 $OLLAMA_HOST | context=$OLLAMA_CONTEXT_LENGTH | keep_alive=$OLLAMA_KEEP_ALIVE"
exec ollama serve
