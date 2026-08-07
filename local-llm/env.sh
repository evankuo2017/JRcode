#!/usr/bin/env bash
# local-llm 共用環境設定 —— 所有腳本 source 這支
# 模型與二進位都放在本資料夾底下，免 root、可隨資料夾搬移。
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export OLLAMA_HOME="$DIR"
export OLLAMA_MODELS="$DIR/models"           # 模型檔存這裡（約 18GB）（在本資料夾下）
export PATH="$DIR/ollama/bin:$PATH"          # 讓 `ollama` 指令可用
export LD_LIBRARY_PATH="$DIR/ollama/lib/ollama:$LD_LIBRARY_PATH"

# 服務參數
export OLLAMA_HOST="0.0.0.0:11434"           # 監聽所有介面，供其他機器連入（見 README）
export OLLAMA_CONTEXT_LENGTH="32768"         # 加大上下文，避免面試官「忘記」前文
export OLLAMA_KEEP_ALIVE="-1"                # 模型常駐 VRAM，不因閒置卸載
