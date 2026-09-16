# Demo 請求結束後釋放資料庫連線

2026-09-16 04:36 台北，現貨及合約引擎已載入 `request-scoped-cleanup-v1`，恢復每五分鐘運行。此修復改善執行可靠性；尚無修復後的成交績效足以判定獲利改善。

## 已重現的缺陷

本機 Freqtrade 的 API 請求清理 `Trade.session`，但自訂交易資料使用另外的 `_CustomData.session`。`_rpc_force_entry` 觸發策略讀取自訂資料後，沒有清理該請求的 session。用實際 `get_rpc`、實際 `_rpc_force_entry`、隔離 SQLite 和模擬策略 callback 重現：第一個請求結束仍佔用一條連線；限制兩條連線的測試池在第二次請求發生 TimeoutError。沒有交易所呼叫。證據：`local/v12-rpc-session-2026-09-16/reproduction-before.json`。

這證實一條可耗盡連線池的程式路徑，與 SUI81 當時的症狀相符；沒有保存事故當時的連線逐筆追蹤，因此不能斷言它是當時唯一成因。

## 修改與驗證

新增 `scripts/demo_rpc_sessions.py`，由兩個 Demo launcher 在啟動時安裝程序內包裝。進場、平倉與取消訂單 RPC 結束時，僅清理相同 API request ID 已存在的 custom-data session。保留原方法的回傳及例外，不碰背景引擎 thread 的 session，不重送委託，不修改安裝的 Freqtrade 或扩大 pool。原生自訂資料寫入會自行 commit；清理會釋放其後讀取交易的連線。

新增測試覆蓋實際 RPC 連續 30 次請求、例外後釋放、正常回傳、已 commit 資料保留、背景 session 隔離、無自訂資料的請求與重複安裝。部署來源上的相關測試：91 項 Python、29 項 JavaScript 全部通過，詳見 `tests.json`。

04:35 維護前兩帳戶均空倉、沒有未知意圖；排空 watch／supervisor 後，按 PID、建立時間及命令確認兩個原生程序再替換。04:36 從新程序的啟動紀錄核對修復 SHA256 及 PID，確認原生保護就緒才恢復 watch。模型、儀表板與鏈上觀察器未重啟；既有 goal、交易計畫、損益及本金基期保持不變。

新權威來源為 `local/v12-rpc-session-2026-09-16/running.json`，共 75 份來源；策略指紋因執行程式來源改變而更新，交易條件、成本、停損與風險參數沒有調整。部署與新週期驗證分別記錄在 `running.json`、`validation.json`。例行 `local/goal30-v12-operation-check.mjs` 已改讀此 manifest 並核對目前程序的清理載入紀錄。

## 另項恢復與後續

04:25 SOL 意圖 `7f43cbea84a69e4a89f8dc00babf85d7` 因最終價格未延續，在原生 callback 被拒絕；完整 Demo SOL 訂單查詢窗 04:24–04:27 為空，完整引擎歷史沒有對應交易。依精確 tag、時間與 source 證據追加 rejected，沒有重送。證據在 `local/v12-reconcile-2026-09-16/sol-native-rejection/rejection-proof.json`。

一般原生條件拒絕仍可能被通用 RPC 錯誤記成 unknown；持久且可驗證的拒絕回執、自動嚴格對帳仍是下一項執行改善。不能憑 HTTP 502 或查無交易直接清除意圖。本次清理也不等同防止所有逾時或保證獲利。
