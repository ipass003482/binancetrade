# v6：共同本金、實際淨利與持續 Demo

使用者已授權現貨及逐倉合約持續 Demo。優先順序見 [交易目標](trading-objective.md)。本版仍使用真實 Binance Demo 虛擬資金成交。

**後續設定更新，台灣 20:57：** 使用者明確取消每日開倉次數上限。現貨與合約 `maxEntriesPerDay` 均由 4 改為 0（不限制每日次數），立即生效；每 5 分鐘照策略與資金條件繼續進場。下方 20:50 的 4/4 與隔日重置是修改前的歷史狀態，已不適用。保留完整成交日誌、共同基期及其餘風控，不需重啟或中斷持倉引擎。稽核紀錄：`local/daily-entry-cap-removed-2026-09-10.json`。

## 完成的五項修改

1. 每日次數、持倉及資金限額等正常等待不再累計成三次程式故障。每根 5 分鐘收盤後重新檢查；每日額度在 UTC 零時，即台灣每日 08:00 重置。未知送單與資料故障仍阻止進場。
2. 原生交易所停損：現貨 STOP_LOSS_LIMIT（limit ratio 0.995），合約 reduce-only STOP_MARKET；每 15 秒更新必要保護。保存委託意圖、client ID、實際 order ID 及查詢證據。模糊回覆只能查詢對帳，不重送。新進場核對目前原生引擎、Windows 程序父子鏈、停損能力及既有持倉的最新有效委託。
3. 新 v6 單統一使用已完成 15 分鐘 ATR 的停損／目標和最長 4 小時退出。全域 ROI 與 trailing 關閉；既有 v1–v5 單保留自己的退出計畫與舊 ROI，舊現貨 trailing 亦保留。5 分鐘進場參數延續 v5，不因驗證而放寬風控。
4. 畫面分開顯示交易引擎、排程、守護、停損證據、完成週期、今日額度與逐幣拒絕原因。統計只使用目前版本最近 24 小時；技術驗證單另列。過期資料顯示不可確認。
5. 現貨與合約共同使用 2,000 USDT 試驗本金。全球 entry lock 跨模式序列化進場；總名義曝險上限 1,050、估計持倉風險上限 4、每日虧損限額 50、觀測回撤限額 100 USDT，保留原有各模式更嚴格限制。跨模式同幣反向持倉也會擋下。回撤限制沿歷史 samples 保持，不因換版而清零。

## 守護行為

`node src/supervisor.mjs --allow-demo-supervision` 每 15 秒檢查已授權持續運行的 Demo。只有程序、鎖擁有者及監聽埠都證明不存在，且連續三輪不可用，才重啟引擎。程序存在但失去回應、程序清單不可讀、或未知送單都會警示，不能假裝已恢復。每種程序 10 分鐘最多嘗試三次。

STOP 僅暫停新進場，守護仍維持引擎退出。守護不清使用者 STOP，也不重送交易。已證明死亡的排程副鎖可清理；共同進場鎖還需確認兩模式日誌均無未決送單。Windows 背景 worker 必須 detached，避免守護自身結束時連帶終止引擎。

## 成績的計算及歸因

共同基期固定為 `2026-09-10T11:43:45.501Z`。`local/portfolio/baseline.json` 明確排除更早的 spot 1–27、futures 1–14，基期後策略單與技術驗證單都影響共同資金，並各自列示。升級只輪替每模式 forward marker，保留原版本 marker/report；共同基期與 equity samples 不重設。

淨利採 Freqtrade 實際 `profit_abs`，不再重複扣費；未平倉另列浮動淨損益。history 與 snapshot 的 open trade IDs 不一致時，只重讀一次，持續變動則暫停該次評估。未知送單使報告不完整，不寫入有效權益樣本。

滑價只有實际成交、完整進出雙邊報價及時間一致時才計算；原生 engine referenceRate 只是引擎參考價，不能冒充獨立市場報價。觀測回撤是已採樣結果，報告保留採樣間距。

## 已取得的實際證據

- 原 v5 SOL 空單 trade 16：2026-09-10 12:10:12 UTC 開倉，12:37:52 UTC `rules_target` 自動平倉，淨利 **+0.78367184 USDT**。它在 v6 重啟前已自然平倉，保留 v5 歸因。
- v6 現貨 ETH 技術驗證 trade 29：0.0102 ETH，進場 24.832512 USDT；進場 ID `11765189102`、有效停損 ID `11765190286`（完整 0.0102 ETH，trigger 2422.39）、自動平倉 ID `11765243168`。`rules_time` 平倉淨利 **-0.00177937 USDT**。這是流程驗證，不列 v6 策略成績。
- 現貨保護完整核對：`local/demo/v6-open-protection-proof.json`；完整 round trip：`local/demo/probe-result-10a339b4-c1c5-4a3a-b920-49a163699f16.json`。
- v6 合約 ETH 技術驗證 trade 17：0.01 ETH 空單、1 倍逐倉，進場 24.3636 USDT；進場 ID `16790127028`、reduce-only 停損 ID `1000000200455874`（完整 0.01 ETH，trigger 2448.54）、平倉 ID `16790127704`。`rules_time` 平倉淨利 **-0.03199588 USDT**。完整證據：`local/demo-futures/probe-result-ccd192b5-57d8-4c8e-8113-00a1273fa3ba.json` 與 `v6-open-protection-proof.json`。
- 合約平倉碰上 history 分頁變動，驗證腳本第一次讀取回報 `HISTORY_CHANGED`；其後只重新查詢原 trade 17，確認完整成交，沒有再開一單。驗證腳本已改成在有限觀察期限內重讀這類歷史競態。
- 兩張保護單其後均經實際 GET 確認 `canceled`；證據在各模式 `v6-terminal-stop-proof.json`。修正了取消回覆仍 open 時的二次查詢，以及空倉後殘留 active 紀錄的核對。不得用本地修改或合成 canceled 冒充撤單。
- 台灣 **20:47:20** 的共同報告：策略 1 筆平倉 **+0.78367184**，技術驗證 4 筆 **-0.08304010**，合計 **+0.70063174 USDT**；本金加本輪損益 **2,000.70063174 USDT**。當時兩邊空倉；觀測最大回撤 **0.42045477 USDT**。這是一筆策略樣本，後续按真實成交持續累積。
- 空倉引擎恢復及守護結束後引擎存活實測：`local/supervisor/engine-survives-supervisor-restart.json`。測試抓到並修正 Windows 非 detached worker 被連帶終止的問題。
- 排程恢復實測：原現貨 watch PID 1480 在無進行中週期／送單時停止，守護自動恢復為 PID 8016，兩個引擎 PID 保持不變。證據 `local/supervisor/watch-recovery-after.json`。
- **20:50 自動週期已完成**：現貨 HOLD（10 個幣種方向／均線條件未通過）；合約自然開出 v6 SOL 空單 trade 18，1.5 SOL、1 倍逐倉、實際投入 **149.205 USDT**，進場價 **99.47**。已查證交易所停損 ID `1000000200463031`，完整 1.5 SOL、觸發價 **99.84**。此單採 v6 ATR 計畫，非技術驗證；證據 `local/demo-futures/v6-strategy-trade-18-proof.json`。
- 20:50:26 兩模式 health 均 healthy、watch 運行、無問題；本輪已實現 **+0.70063174 USDT**，當時持倉浮動 **-0.13437 USDT**，合計 **+0.56626174 USDT**，見 `local/v6-activation-proof.json`。損益隨市場更新，後續以最新 portfolio report 為準。
- 當日現貨／合約額度均已用 4/4（包含既有提交與技術驗證），仍持續檢查訊號與管理退出；台灣 **2026-09-11 08:00** 自動重置。沒有提高每日次數或其他風控上限。

## 驗證與持續觀察

完整測試目前 295 項 JS、155 項 Python 通過，105 個 JavaScript 檔案語法與配置檢查通過；獨立 dry-run 原生下單／平倉 smoke 通過。結果在 `local/v6-node-tests.log`、`local/v6-python-tests.log`、`local/v6-check.log`、`local/v6-native-smoke.log`。

每版至少累積 30 筆有效策略平倉後，按實際平均淨利、盈虧比、費用與回撤評估下一步；只做有成交證據支持的參數調整。每 6 小時既有自動檢查持續追蹤本版。

本版原生停損方式對照 [Freqtrade 官方交易所說明](https://www.freqtrade.io/en/stable/exchanges/) 與 [官方停損說明](https://www.freqtrade.io/en/stable/stoploss/)。現貨是停損限價委託，快速跳空時可能未立即成交；這個限制在委託種類與估計風險中保留。
