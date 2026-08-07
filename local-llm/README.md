# 在本機自架 LLM（給 JRcode 用）

用你自己的電腦跑 **Qwen3-Coder-30B** 模型，當 JRcode 的 AI 後端——**免費、私密、不限流量**，不必依賴雲端 API。

## 你需要準備

- 一台有 **NVIDIA GPU** 的電腦（本模型執行約需 **21GB VRAM**，建議 24GB 以上；例如 RTX 3090/4090、A6000）。
- 作業系統 **Windows 或 Linux/macOS 都可以**。
- 這台可以就是你跑 JRcode 的電腦，也可以是**同一個區網內的另一台**（例如 GPU 工作站）。

> **重要觀念**：JRcode 是透過一個**網址**去呼叫模型（OpenAI 相容 API），**和作業系統無關**。所以你只要把模型裝在「**有 GPU 的那台**」，再讓 JRcode 填對網址即可——JRcode 端不需要安裝任何模型相關的東西。

---

## 步驟 1：安裝並啟動模型

依你「有 GPU 那台」的系統選一種。

### 🪟 Windows

1. 到 <https://ollama.com/download> 下載 **Ollama for Windows** 安裝檔並安裝。
   安裝後 Ollama 會**自動在背景執行**（右下角系統匣有個羊駝圖示），並在 `http://localhost:11434` 提供服務。

2. 開一個 **PowerShell**（或命令提示字元），下載模型：
   ```powershell
   ollama pull qwen3-coder:30b
   ```

3. **（建議）調整三個設定**，讓它更適合 JRcode：
   ```powershell
   setx OLLAMA_HOST "0.0.0.0:11434"      # 允許其他電腦連進來（只本機用可略過）
   setx OLLAMA_CONTEXT_LENGTH "32768"    # 加大上下文，避免對話中「忘記」前文
   setx OLLAMA_KEEP_ALIVE "-1"           # 模型常駐顯示卡，不因閒置卸載（避免突然卡好幾秒）
   ```
   `setx` 設定後，**要重啟 Ollama 才會生效**：在系統匣圖示按右鍵 → Quit，再從開始選單重新打開。

4. **確認在跑**：`ollama ps`（應看到 `qwen3-coder:30b`）。關閉就從系統匣圖示 Quit。

### 🐧 Linux / macOS

用本資料夾附的腳本（免 root、整包放在資料夾內）：
```bash
cd local-llm
./install_ollama.sh     # 下載 Ollama 到 ./ollama
./pull_model.sh         # 下載模型（約 18GB）到 ./models
./start_server.sh       # 啟動；背景執行： nohup ./start_server.sh >server.log 2>&1 &
```
常用指令：
```bash
curl -s http://localhost:11434/api/version     # 有回應 = 服務開著
source env.sh && ollama ps                      # 看模型是否載入、是否 100% GPU
./stop_server.sh                                # 關閉並釋放顯示卡記憶體
```
（`env.sh` 已幫你設好上面 Windows 那三個參數。）

---

## 步驟 2：把 JRcode 接上來

在 JRcode 的 `server/.env` 填：

```env
LLM_API_KEY=ollama
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen3-coder:30b
LLM_FALLBACK_MODELS=
OBSERVER_MODEL=qwen3-coder:30b
```

- **模型和 JRcode 在同一台** → `LLM_BASE_URL` 用 `http://localhost:11434/v1`。
- **模型在另一台**（例如 GPU 工作站）→ 改成那台的區網 IP，例如
  `http://192.168.1.50:11434/v1`。
  這時「模型那台」要：① 服務監聽 `0.0.0.0`（Windows 用上面的 `setx OLLAMA_HOST`；Linux 的 `env.sh` 已設好）② **防火牆放行 11434 埠**。

改完 `.env` 記得**重啟 JRcode**（`.env` 不會自動重載）。

---

## 步驟 3：確認整套正常

任一平台，跑這個測試（把 `localhost` 換成模型那台的 IP）：
```bash
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-coder:30b","messages":[{"role":"user","content":"你好"}]}'
```
回一段正常的 JSON 對話就成功了。JRcode 首頁應顯示模型名稱、紅色 API key 警告消失。

---

## 常見問題

- **回應要等好幾秒 / 很慢**：多半是沒吃到 GPU（在跑 CPU）。用 `ollama ps` 確認顯示 `100% GPU`；若顯示 CPU，通常是 GPU 驅動問題，重開機或更新驅動後再試。
- **其他電腦連不到**：確認模型那台服務監聽 `0.0.0.0`、防火牆開了 11434；若模型跑在 Docker 容器裡，還要在主機端把埠映射出去（`docker run -p 11434:11434 ...`）。
- **(Windows) `setx` 設了沒效果**：要**重啟 Ollama**（系統匣 Quit 再開）才會讀到新設定。
- **(Linux) `ollama` 指令找不到**：先 `source env.sh`。
- **(Linux) `install_ollama.sh` 解壓失敗（缺 zstd）**：`sudo apt install zstd`（或 `brew/conda install zstd`），或改用官方安裝 `curl -fsSL https://ollama.com/install.sh | sh`。
- **VRAM 不夠**：這顆 30B 約需 21GB；顯示卡較小可改用較小模型（如 `ollama pull qwen2.5-coder:7b`）並同步改 `.env` 的 `LLM_MODEL`。
