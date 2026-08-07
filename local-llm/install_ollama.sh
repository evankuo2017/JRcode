#!/usr/bin/env bash
# 下載 Ollama 執行檔到本資料夾的 ollama/（免 root、免系統安裝）
# 僅支援 Linux x86_64；其他平台請改用官方安裝：https://ollama.com/download
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"; mkdir -p ollama
TAG=$(curl -fsSL https://api.github.com/repos/ollama/ollama/releases/latest \
      | grep -oE '"tag_name":[[:space:]]*"v[0-9.]+"' | grep -oE 'v[0-9.]+' | head -1)
[ -n "$TAG" ] || { echo "取得版本失敗，請檢查網路"; exit 1; }
echo "下載 Ollama ${TAG} (linux-amd64)..."
curl -fL "https://github.com/ollama/ollama/releases/download/${TAG}/ollama-linux-amd64.tar.zst" -o /tmp/ollama.tar.zst
echo "解壓到 ./ollama ..."
if tar --zstd -xf /tmp/ollama.tar.zst -C ollama/ 2>/dev/null; then :
elif command -v unzstd >/dev/null 2>&1; then unzstd -c /tmp/ollama.tar.zst | tar -x -C ollama/
elif command -v zstd    >/dev/null 2>&1; then zstd -dc /tmp/ollama.tar.zst | tar -x -C ollama/
else
  echo "缺少 zstd（或支援 --zstd 的 tar）無法解壓。"
  echo "請先安裝 zstd，或改用官方安裝：curl -fsSL https://ollama.com/install.sh | sh"
  exit 1
fi
rm -f /tmp/ollama.tar.zst
echo "完成： $("$DIR/ollama/bin/ollama" --version 2>&1 | head -1)"
