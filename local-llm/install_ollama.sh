#!/usr/bin/env bash
# 下載 Ollama 執行檔到本資料夾的 ollama/（免 root、免系統安裝）
# 僅支援 Linux x86_64；其他平台請用官方安裝：https://ollama.com/download
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"; mkdir -p ollama

TAG=$(curl -fsSL https://api.github.com/repos/ollama/ollama/releases/latest \
      | grep -oE '"tag_name":[[:space:]]*"v[0-9.]+"' | grep -oE 'v[0-9.]+' | head -1)
[ -n "$TAG" ] || { echo "取得版本失敗，請檢查網路"; exit 1; }

PKG="/tmp/ollama-${TAG}-linux-amd64.tar.zst"
if [ -s "$PKG" ]; then
  echo "重用已下載： $PKG"
else
  echo "下載 Ollama ${TAG} (linux-amd64)..."
  curl -fL "https://github.com/ollama/ollama/releases/download/${TAG}/ollama-linux-amd64.tar.zst" -o "$PKG"
fi

# 找一個可用的 zstd（PATH → 常見 conda/anaconda 位置）
find_zstd() {
  local c
  for c in zstd "$HOME/anaconda3/bin/zstd" "$HOME/miniconda3/bin/zstd" \
           "$HOME/anaconda3/envs"/*/bin/zstd "$HOME/miniconda3/envs"/*/bin/zstd \
           /opt/conda/bin/zstd; do
    if command -v "$c" >/dev/null 2>&1; then echo "$c"; return 0; fi
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

echo "解壓到 ./ollama ..."
if tar --zstd -xf "$PKG" -C ollama/ 2>/dev/null; then
  :                                            # GNU tar ≥1.31 內建 zstd
elif ZSTD=$(find_zstd); then
  "$ZSTD" -dc "$PKG" | tar -x -C ollama/       # 用找到的 zstd
else
  echo "找不到 zstd（也沒有支援 --zstd 的 tar）無法解壓。請擇一："
  echo "  • 安裝 zstd： sudo apt install zstd  /  brew install zstd  /  conda install -y zstd"
  echo "  • 或用官方安裝： curl -fsSL https://ollama.com/install.sh | sh"
  exit 1
fi

echo "完成： $("$DIR/ollama/bin/ollama" --version 2>&1 | grep -v Warning | head -1)"
