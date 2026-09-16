# Demo 研究排程對齊 — 2026-09-09

依使用者要求，只調整研究時間，不變更 15m K 線、單筆金額、額度、進出場策略或現有持倉。

- Demo 現貨與 Demo 合約 watch 在 UTC／台灣時間每小時 00、15、30、45 分收盤後 5 秒開始研究；這是研究開始時間，不是成交時間。
- 不再以研究完成時間加 900 秒計算下一輪。超時不連續追補；排程喚醒超過 60 秒寬限就跳過該輪。系統時間倒退時不重複已認領的時段。
- 同一模式的 watch.lock 保證單一研究程序；在研究之前原子保存 local/<mode>/candle-schedule.json 的 boundary，重啟、研究失敗都不再重跑同一排程時段。這不宣稱能阻止使用者另行呼叫手動 cycle/execute；原有 snapshot journal 仍負責訂單去重。
- 所有候選商品最後一根 K 線必須對應該次預期完成的 15m candle，否則拒絕該輪，不把舊 K 線當作新訊號。若連續失敗，沿用原本健康管理的暫停機制，不放寬資料時效。
- 程序在兩個收盤時段之間啟動會等下一時段，不立即拿舊資料進場。只有仍在收盤後 5 秒緩衝前啟動，才可接上當次即將開始的研究。
- health.json 記錄 waiting_candle 和 nextResearchAt，heartbeat 在等待期間繼續更新。
- 引擎硬止損／ROI／已配置追蹤止盈獨立運作，不等待研究；本次沒有新增文字失效條件退出。
- dry-run watch 與手動 cycle 的原有行為維持不變。

測試：94 項 JS、42 項 Python、語法檢查及原生 Freqtrade dry-run smoke 通過。原生證據：local/native-smoke/022d87ba-6f58-4a85-b495-2bfc92aa08b3/result.json。新增測試涵蓋收盤邊界、研究耗時、過期喚醒、時間倒退、重啟防重、缺少新 K 線時不呼叫分析或執行。

修改檔案：src/candle-schedule.mjs、src/cli.mjs、src/workflow.mjs、test/candle-schedule.test.mjs。未自動 commit/push。

## 2026-09-10：交易所時間校驗、送單前換根檢查與監控畫面

9 月 9 日的收盤後 5 秒排程已完成，本次保留原排程，補上三項功能：

1. 每輪研究共用所屬市場的 Binance 公開時間樣本，依交易所時間選取同一根已收盤 15m K 線。往返超過 1.5 秒、可能偏差超過 ±2 秒、樣本超過 60 秒、時間跳動或取得失敗時拒絕新進場；不修改 Windows 系統時鐘。
2. 進場送單前重新取交易所時間，並在所有非同步前置檢查後、HTTP POST 前同步再核對。只要研究之後已換一根 K 線，即使尚在 600 秒訊號期限內也拒絕；時間誤差範圍跨越收盤邊界同樣拒絕。保留既有 STOP、報價期限與訂單不明狀態處理，持倉退出不受新增進場條件阻擋。校驗證據寫入各輪 `.timing.json`，新邏輯納入策略版本指紋。
3. 儀表板增加時鐘偏差、最後已取得收盤、K 線延遲、下一根收盤、下一輪研究與訊號到期。顯示台灣時間，倒數採交易所時間與單調計時；停用狀態、未啟動排程、研究失敗、資料超過 45 秒與展示資料分別呈現。研究時間顯示補償本機偏差，不改動排程器。API 不快取時鐘狀態，市場資料仍依既有短期快取提供。

時間 API：[現貨官方文件](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/general-endpoints)、[合約官方文件](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Check-Server-Time)。使用專案各模式的既有公開主機，Demo 現貨與合約保持分離。

驗證：149 項 JavaScript、42 項 Python、67 個檔案語法檢查通過；原生 Freqtrade dry-run smoke 完成進出場，結束 0 持倉、0 真實訂單。證據：`local/native-smoke/9ab46e2f-867a-4034-8e7f-82d89faabf99/result.json`。Demo 仍保持 STOP，未啟動 watch。本次沒有宣稱或驗證穩定獲利。
