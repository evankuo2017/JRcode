# local-llm — 自架本地模型（選用）

在自己的機器上跑 **Qwen3-Coder-30B**，對外提供 **OpenAI 相容 API**，讓 JRcode 不必依賴雲端 API。

## 先搞懂架構（重要，消除 OS 焦慮）

JRcode 和模型伺服器是透過 **HTTP（OpenAI 相容 API）溝通，與作業系統無關**——就像瀏覽器連伺服器，不用管對方是什麼系統。所以有兩種擺法：

- **同一台機器**：JRcode 和 Ollama 都在你這台（Windows 或 Linux）。JRcode 連 `http://localhost:11434/v1`。
- **分開兩台**（常見）：模型跑在**有 GPU 的機器**（例如 Linux 工作站的 A6000），JRcode 跑在**另一台**（例如 Windows 筆電），JRcode 連 `http://<GPU機器IP>:11434/v1`。

> 重點：**Ollama 要裝在「有 GPU 的那台」**，用那台的作業系統對應的方式安裝。JRcode 端只需要填對 API 位址，不用裝任何模型相關東西。

需要 NVIDIA GPU（建議 24GB＋ VRAM）才有實用速度。`ollama/`、`models/` 不進版控，用下方步驟重新取得。

---

## 安裝與啟動

### Linux / macOS（用本資料夾的腳本）

```bash
cd local-llm
./install_ollama.sh     # 下載 Ollama 到 ./ollama（免 root）
./pull_model.sh         # 下載模型（約 18GB）到 ./models
./start_server.sh       # 啟動；背景： nohup ./start_server.sh >server.log 2>&1 &
```
檢查 / 關閉：
```bash
curl -s http://localhost:11434/api/version     # 有回 {"version":...} = 開著
source env.sh && ollama ps                      # 看是否 100% GPU
./stop_server.sh                                # 關閉、釋放 VRAM
```
`env.sh` 已設好監聽 `0.0.0.0:11434`、context 32768、keep-alive 常駐。
> 手動停用 `pkill -x ollama`，**不要** `pkill -f "ollama serve"`（會誤殺當前 shell）。

### 🪟 Windows（用官方安裝檔 + PowerShell）

本資料夾的 `.sh` 腳本在 Windows 不能跑，改用官方方式：

1. 到 <https://ollama.com/download> 下載 Windows 安裝檔（.exe）裝好。
2. 開 PowerShell，設定環境變數並啟動服務：
   ```powershell
   $env:OLLAMA_HOST="0.0.0.0:11434"     # 供其他機器連入；只本機用可省略
   $env:OLLAMA_CONTEXT_LENGTH="32768"   # 加大上下文
   $env:OLLAMA_KEEP_ALIVE="-1"          # 模型常駐、不閒置卸載
   ollama serve
   ```
3. 另開一個 PowerShell 視窗下載模型：
   ```powershell
   ollama pull qwen3-coder:30b
   ```
檢查 / 關閉：
```powershell
ollama ps                    # 看模型是否載入、100% GPU
ollama stop qwen3-coder:30b  # 卸載模型
# 關整個服務：關掉 ollama serve 那個視窗，或用工作管理員結束 ollama.exe
```
> 想開機自動常駐，可把上面的環境變數設到「系統環境變數」，Ollama 桌面版就會沿用。

---

## 連接 JRcode

伺服器位址 `http://<IP>:11434/v1`，模型名 `qwen3-coder:30b`。填進 JRcode 的 `server/.env`：

```env
LLM_API_KEY=ollama
# 同機： http://localhost:11434/v1
# 分開兩台： http://<GPU機器IP>:11434/v1   例 http://192.168.1.50:11434/v1
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen3-coder:30b
LLM_FALLBACK_MODELS=
OBSERVER_MODEL=qwen3-coder:30b
```
存檔後重啟 JRcode（`.env` 不會自動重載）。

**跨機注意**：模型那台要讓服務監聽 `0.0.0.0`（Linux 的 `env.sh` 已設；Windows 用上面的 `$env:OLLAMA_HOST`），並開放防火牆 11434 埠。若模型跑在容器內，需在**主機端**映射埠（`docker run -p 11434:11434 ...`）。

**測試**（任一平台）：
```bash
curl http://<IP>:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-coder:30b","messages":[{"role":"user","content":"你好"}]}'
```

## 疑難排解
- **回應很慢**：確認有吃到 GPU（`ollama ps` 應顯示 `100% GPU`），否則是在跑 CPU（多為 GPU 驅動問題）。
- **`ollama` 找不到**（Linux）：先 `source env.sh`。
