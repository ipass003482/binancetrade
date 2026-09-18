# AI 高頻影子層（2026-09-18）

這次把高頻 AI 做成獨立的研究觀測器，不改寫目前 Demo 的下單權限。現行 Demo 仍由訂單流規則、原生保護單與既有分鐘排程負責執行；影子層只讀取 Binance 公開行情，產生候選，並觀察候選在指定時間後的價格 markout。

## 行為

- 每 1 分鐘收集 BTC、ETH、SOL、BNB 的 book ticker、前五檔深度、最近主動成交與已收盤 1 分鐘 K 線。
- 每 5 個週期才重新請 AI 選擇 `auto`、`momentum`、`mean-reversion` 或 `breakout` 及其受限敏感度；中間週期沿用上一個受控設定，不呼叫模型。
- 目前只記錄 `buy` 候選，經過 60 秒後以可取得的 bid 計算原始 markout，再扣除研究用雙邊成本情境。沒有帳戶佣金讀取，也沒有把 markout 當成已實現損益。
- `tradeEnabled:false`、`mode:dry-run` 與 `orderAuthority:none` 是固定契約。這條路徑沒有送單、沒有開倉、沒有改動現有持倉。
- 輸出保存於 `local/ai-high-frequency/shadow-state.json`、`shadow-report.json` 與 append-only `shadow-events.jsonl`；樣本明確標記為 evidence-only，而且同一分鐘行情下的樣本可能相關，不能直接當作獲利率或穩定獲利證明。

## 驗證

已通過 693 個 JavaScript 測試、797 個 Python 測試，以及 182 個 JavaScript／設定檢查。另以兩個真實公開行情週期執行 `scripts/ai-high-frequency-shadow.mjs`，第二週期未呼叫模型仍能產生合法 HOLD 觀測提案；全程沒有交易寫入。

這個版本先提供可重複的樣本與成本調整證據。只有在前向樣本數、缺失率、成本後 markout 與現行規則比較達到明確門檻後，才適合另行評估是否擴大 AI 的研究範圍；本次部署不宣稱獲利或勝率改善。
