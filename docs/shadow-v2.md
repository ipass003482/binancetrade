# AI 影子觀測 v2 維護說明

2026-09-21。這是公開行情研究程序，不讀取交易帳戶、佣金憑證或送出訂單。
`tradeEnabled:false`、`orderAuthority:none` 不因 AI 回覆改變。

## 觀測時間與成本

- 主策略循環按固定時段執行；AI 或資料收集太慢時跳過錯過的時段，記錄
  `skippedCycles`，不補跑或回填行情。
- AI 輪只接受最終合法 `buy` 且商品與受控策略候選一致的結果。HOLD、候選缺失、
  證據拒絕、商品不符都不能退回另一個自動候選。中間輪才沿用已接受的 AI 策略設定。
- AI 完成後重新讀取公開 `bookTicker`，用實際接收時間和 ask 建立 anchor。
  `sourceSnapshotAt`、`decisionAt`、`anchorRequestedAt`、`anchorAt` 分別保存，
  不將 AI 看到的舊價格當成 AI 完成後的進場價格。
- `src/shadow-quote-resolver.mjs` 為每個 anchor 獨立排程，到 `targetAt` 才讀新報價。
  resolver 不等待下一輪模型推論。預設 horizon 60 秒，只接受 anchor 後 **60–65 秒**
  的實際 quote receipt；晚到、缺資料或休眠後恢復都保留 unavailable，不放寬時間窗。
- `executableQuoteMarkoutBps` 是 future bid / anchor ask 的報價變化，已包含價差。
  `slippageAdjustedMarkoutBps` 只另外扣固定的雙邊滑價情境，不再次扣價差。
  佣金未知，`feeStatus:unavailable`、`netMarkoutBps:null`；這些數字不是成交損益。
- 每個成功標籤保存 `actualElapsedMs`。報表只合併目前 label/observation method；
  其他方法保留原始 state，透過 `excludedOtherObservationMarkouts` 明示排除。

## 寫入、重啟與停止

`shadow-worker.lock` 防止同一目錄的兩個 worker 同時執行；`shadow-state.lock`
配合程序內序列化佇列，讓策略循環與 resolver 都透過同一寫入路徑更新 state/report。
timer 不各自覆寫舊快照。程序異常退出留下鎖時，必須核實原程序已停止再處理鎖，
不可在仍有寫入者時刪除。

第一次讀取 v1 state 時，先以 exclusive-create 保存 `shadow-state.v1.json` 和
`shadow-report.v1.json` 原始 bytes，才建立 v2。檔名已存在而內容不同會拒絕升版。
舊 pending 不補評，舊結果列在 `legacyCohorts`，不混入 v2 平均值。
原本 append-only `shadow-events.jsonl` 保留；新增行帶 version 與 labelVersion。

重啟會恢復尚在期限內的 pending；已過 65 秒者直接標記 expired，不能用最新報價
填補。有限 `--cycles` 完成後會等既有 pending 解析完才退出。目錄中的 `STOP`
會阻止新 anchor；主循環等待及最後 drain 每秒檢查 STOP，取消未開始的 timer，
pending 保留供下一次明確重啟分類。已開始的公開請求最多等待其短 timeout。

worker 記憶體只保留最近 32 筆精簡 cycle 摘要，總輪次另記 `executedCycles`；
完整研究快照與結果仍在 runs/、latest.json 和事件檔。

## 有限且不呼叫 AI 的公開資料 smoke

在專案根目錄執行：

```powershell
node scripts/ai-high-frequency-shadow.mjs --cycles 1 --no-ai --local work/shadow-v2-smoke
```

這會真實讀取公開行情、輸出 v2 研究報表；不呼叫 AI，也不製造候選或 markout。
檢查回傳 `executedCycles:1`、`tradeEnabled:false`、`aiReviews:0`、
`activePending:0`，並核對 `cycles[0].marketCount` 及該目錄 latest.json 的 errors。
市場來源失敗不應被零 label 誤解成測試成功。

真 AI 的一次有限觀測可用：

```powershell
node scripts/ai-high-frequency-shadow.mjs --cycles 1 --local work/shadow-v2-ai-smoke
```

AI 沒有給出合法 BUY 時，0 label 是正常結果。有合法候選時，會在 AI 完成後
抓新 anchor，等待約 60 秒解析。預設不傳 `--local` 才會使用既有
`local/ai-high-frequency` 並進行歷史升版。

定向回歸：

```powershell
node --test --test-concurrency=1 test/ai-high-frequency.test.mjs test/high-frequency-shadow.test.mjs test/shadow-quote-resolver.test.mjs
```

回歸使用假的行情／模型與虛擬時鐘，涵蓋慢 AI 期間 resolver 獨立完成、固定節拍
跳過、時間窗邊界、停機恢復、STOP、無效候選、只扣一次價差、未知佣金、歷史保存
及長跑記憶體上限，不連線交易。
