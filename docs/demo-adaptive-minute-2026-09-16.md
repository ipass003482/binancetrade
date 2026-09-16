# 每分鐘訂單流與動態參數 Demo

使用者 2026-09-16 授權：平掉全部既有 Demo 持倉，啟用每分鐘判斷與可機動調整的參數，今天現貨／合約各 50 筆新成交。由 minute_cadence、adaptive_parameters、review20_model 三位智慧體分工並互相核對，root 整合、平倉及部署。

## 實際變更

- `flow-minute-v1`：每分鐘新快照、訂單流與報價；每分鐘先保存排程領取紀錄，過期或程序重啟不補送同輪。現貨分鐘後 5 秒、合約後 15 秒開始收集，下個分鐘邊界嚴格到期。
- K 線仍為完整 5m 資料，計算完整 15m ATR；這是風險距離，並非等待五分鐘才作判斷。獨立模型只讀每個 5m 邊界的那次快照。
- `live-flow-adaptive-v1`：每次評估及下單前由原始證據重算參數。以 spread / ATR、完整來回成本 / 3ATR、基準風險對应的名義金額 / 三次觀測中最小對手五檔深度，各自限制為 0 至 1 的壓力比例。
- 風險倍率 = 1 / (1 + 三個壓力比例之和)，每筆計畫風險 0.25 至 1 USDT。成交力道門檻 = 55% + 3% × 價差壓力 + 2% × 深度壓力；成本緩衝 = 30 + 10 × 價差壓力 bps。保留交易所最小金額、總曝險、原生停損與資金限制。
- 上述區間是待前瞻驗證的工程設定，不是從少量獲利交易擬合出來的最佳參數。主要變化是依可觀測條件縮倉；沒有利用目標筆數降低門檻。
- 原生 guard v11 在 callback、委託 context 與 wire 前重算參數與期限；過期、參數被改寫、超出縮小後預算都拒絕。舊 v10 契約仍相容，不把此相容性宣稱為能抵抗有本機寫入權限者的降級攻擊。
- 顯示每分鐘倒數與新鮮度。停止同步等待無關 Web3 查詢；資金流觀察器仍獨立執行。每筆規則與 entry-plan 保存實際自適應輸入和輸出。

## 已完成平倉與新目標

現貨核對時已平倉；BNB 合約 #2 於 UTC 05:20:37.471 強制退出成交，淨利 0.0295104 USDT。原生持倉均為 0，交易所委託也核對為空；現貨原有殘餘庫存／dust 不當作程式持倉出售。

新目標開始：2026-09-16 13:29:39.077 台北，排他截止 2026-09-17 00:00 台北，現貨／合約各 50 筆真正策略開倉。保留原 session、歷史交易和損益；新目標排除之前現貨 #1–7、合約 #1–2。改版前現貨淨損 1.20949276、合約淨損 0.59845848 USDT。

目標：[goal.json](../local/trade-goals/2026-09-16-adaptive-minute-50-each/goal.json)。[平倉證據](../local/adaptive-minute-2026-09-16/closed-proof.json)、[新舊邊界](../local/adaptive-minute-2026-09-16/trial-boundary.json)。原目標不覆寫，平倉、拆單、HOLD、未成交及逾期成交不增加新目標計數。

## 驗證與運行

最新包含負向回執修復：682 JS、761 Python、174 檔語法檢查通過；原生隔離 smoke 完成進出場，真實委託數為 0。[驗證紀錄](../local/adaptive-minute-2026-09-16/validation.json)。

37 份保存觀察的 JS／Python 參數完全一致。同時間歷史觀察重分類，現貨原本 11 個、合約 7 個符合條件，修改後仍符合且可達最低下單量；這不是新成交或盈利證據。[交叉審查](../local/adaptive-minute-2026-09-16/adaptive-review.md)。

部署權威：[running.json](../local/adaptive-minute-2026-09-16/running.json)、[source-deployment.json](../local/adaptive-minute-2026-09-16/source-deployment.json)。檢查命令：`node local/adaptive-minute-2026-09-16/check-running.mjs`。需使用本環境 bundled Node。原始 reset checker 的固定路徑屬上一版，當前 wrapper 使用新部署 manifest 但仍驗證原 session、完整歷史、原生保護和模型 pin。

在 UTC 05:39:41.472 的 [部署核對](../local/adaptive-minute-2026-09-16/rejection-paused-check.json) 中，114 份來源一致；兩模式均空倉、未知委託 0、原生保護能力與模型 pin 已核對。當次原生 PID 現貨 19508、合約 22540。UTC 05:39:41.583 [恢復每分鐘排程](../local/adaptive-minute-2026-09-16/resumed.json)，新目標開始點與午夜截止未變；這是部署時的觀察，不是後續即時持倉或達標結果。

模型 checkpoint 權重完全相同；因快照選擇器實作修改，受控重新載入後的指紋是 `26648aab59dd5b993f35385993cbcd6e8911f8ba45a819973dfd83ebd2788af6`。舊預測與 restart 次數保留，模型仍僅觀察、不決定訂單流是否進場。

評估改善必須看新輪實際扣費損益、回撤、平均盈虧和成本；測試通過、頻率提高與理論 3ATR 空間均不代表已證明盈利。

## 13:31 拒單與回執處理

XRP 訊號起始賣價 1.2983，主程式新報價在 UTC 05:31:09.643 為 1.2986；原生 callback 於 05:31:11.340 使用 1.2982，低於起點而拒絕。安裝的 Freqtrade `get_valid_enter_price_and_stake` 明確呼叫 `get_rate(refresh=True)`，按 `entry_pricing` 的 `other / use_order_book / top1` 重新抓取 Demo 賣一價；沒有自訂進場價覆寫。其後 05:31:37.431 採樣賣價 1.2979 支持價格已回落的解讀。原生該次深度回應未保存，因此不宣稱精確重建所有價格變動，也沒有快取報價缺陷的證據。

證據：[entry-plan](../local/demo/entry-plans/codex-1e5c816feff35e221f15c50b45581959.json)、[主程式報價](../local/demo/runs/b7ca8720-0415-4e76-aba6-8aca10b8de9b.1e5c816feff35e221f15c50b45581959.execution-quote.json)、[原生日誌](../local/adaptive-minute-2026-09-16/demo-engine.err.log)。價格延續拒絕需保留；不能拿較早主程式報價取代後來原生報價強行通過。

負向回執修復已包含於 13:39 部署：原生在送單前條件拒絕時保存可追溯的回執；主程式驗證它精確對應本次 tag、pair、snapshot 與計畫，且能證明沒有開始送單，才將該次委託記為 rejected / filtered，讓下一分鐘使用新證據重新判斷。缺失、損壞、時間不符、矛盾及已送出的未知結果仍維持 unknown，不能僅靠 HTTP 502 或找不到交易就解鎖。

修復前的 XRP 意圖 `1e5c816feff35e221f15c50b45581959` 已依 [原生拒單與交易所核對的獨立審查](../local/adaptive-minute-2026-09-16/xrp-rejection-independent-review.json) 於 UTC 05:36:07.220 追加 rejected；沒有倒填新回執，也不重送該意圖。完整舊虧損及 goal 開始點保留。

## ATR 比較決定

本版維持 15m ATR，同時每分鐘判斷訂單流。已讀取全部 14 個設定交易對的真正 1m／5m／15m 完整 K 線，以共同 UTC 05:29:59.999 收盤點比較。按保存費率情境，通過原成本與風險距離條件的數量為 1m：0/14、5m：1/14、15m：6/14。現貨費率在抓取時已超過五分鐘有效期，因此其比較明確為 scenario-only；合約當次費率仍在有效期。這些是計畫距離檢查，不是成交或勝率。

[完整 ATR 比較與來源](../local/adaptive-minute-2026-09-16/atr-horizon-review.md) 說明：14 根 1m／5m／15m ATR 同時改變觀察時間和停損／目標尺度，直接縮短會讓成本更難覆蓋。尚無證據支持本版切换出場尺度或放大倍數；進場判斷速度已由新分鐘排程改善。

## 已運行的新分鐘證據（台北 13:41）

13:40 合約 ETH/USDT:USDT #3 真正做空成交，tag `codex-7c93916ad3a61ca0910d5c518edb7ff1`；原生保護已核對。該筆動態計畫風險為 0.77865778586 USDT，依當時成本、價差和深度從 1 USDT 上限縮減；這是風險估計，不是保證停損金額。13:41 兩模式再次完成判斷，decisionBoundary 為 13:41、candleBoundary 為 13:40，證實非五分鐘整點可運行。[來源與非整點週期核對](../local/adaptive-minute-2026-09-16/live-minute-check.json)通過，無未知委託。

13:41:40 新目標現貨 0/50、合約 1/50，狀態 collecting，兩邊本輪已實現淨損益均 0；尚未證明盈利改善。查核後程式維持 Demo 運行，50 筆目標未完成，截止不變。舊損失保留。

## 資料解讀

[Binance 官方 Market Streams](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams) 區分 aggregate trades 與 depth streams；aggregate trade 的 maker 欄位用來辨別主動方。[官方 REST market endpoints](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints) 定義深度與聚合成交查詢。本程式仍是 Demo REST 約 10 秒抽樣，不宣稱已接逐事件 OFI／WebSocket，也不把加快判斷稱為降低資料源延遲。
