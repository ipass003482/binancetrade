# 2026-09-11 Demo 定期檢查

## 實際成交，台灣 07:51

共同基期仍為 `2026-09-10T11:43:45.501Z`、本金 2,000 USDT，未重設任何損益或權益樣本。

| 分組 | 已平倉 | 已實現淨損益 USDT |
|---|---:|---:|
| v6 現貨策略 | 6 | -3.60799019 |
| v6 合約策略 | 6 | -4.09519748 |
| v6 合計 | 12 | -7.70318767 |
| 原 v5 策略 | 1 | +0.78367184 |
| 全部技術驗證單 | 4 | -0.08304010 |
| 共同基期全部已平倉 | 17 | -7.00255593 |

當時合約持有交易 #24：SOL/USDT:USDT 空單 1.51 SOL，進場 98.83、讀取價 98.99，未實現 -0.36108328 USDT。原生買入停損 `1000000200948017`，完整數量 1.51，觸發價 99.17，已核對。

含浮動共同淨損益 -7.36363921 USDT，預算權益 1,992.63636079，最大已觀測回撤 8.98132135 USDT；沒有觸及 100 USDT 共同回撤上限。兩模式無未決進場委託或未知保護單。每日開倉次數均為 0，即不設上限。

v6 現貨、合約各 6/30 筆初步比較參考；合計 12 筆中 1 筆獲利、11 筆虧損。初步表現為負，不能把程式通過功能測試稱作策略改善。完整兩模式歷史已讀取、forward 與共同 portfolio 已刷新。

## 現貨暫停的來源與恢復

現貨 STOP 為原生保護程序在 UTC `2026-09-10T17:32:11` 寫下的 `DEMO_STOP_CANCEL_UNCONFIRMED`，不是每日次數限制或使用者暫停。ETH 交易 #33 退出期間，撤單未立即取得最終狀態，後續原生 GET 已確認原 stop `11772579381` 及其後替代 stop 全部 canceled；交易本身於 UTC 17:32:30.960 以 `rules_target` 完成。

恢復前核對兩引擎程序與父子鏈、兩模式完整 history/journal、現貨全部停損終態、無孤兒有效委託及合約 #24 當前保護。沒有重送未知委託。保存原 STOP 與核對證據後，UTC 23:52:22 恢復現貨進場，由既有守護重啟 watch。

证據：`local/demo/cancel-stop-recovery-2026-09-11.json`。原未知撤單時的暫停行為保留；恢復前必須有最終交易所證據。

## 本輪已實作：暫停期間繼續觀測

發現現貨 watch 在 STOP 後退出，連帶停止逐筆 forward 損益觀測。ETH #33、NEAR #34、XRP #35 的觀測間隔因此出現 22,763.307 秒空缺；本次重讀已取得真正平倉損益，但缺失的持倉路徑沒有補算。

新增 `src/paused-evidence.mjs`，由 supervisor 在持續 Demo 已授權、引擎可讀、進場處於 STOP 時，約每分鐘刷新 forward／profitReview 與共同 portfolio。正常運行仍由 watch 原有採樣負責。兩模式共享的 portfolio 不在同輪重複更新；讀取失敗保留明確 unavailable 並限速。觀測不清 STOP、不送單、不核銷未知委託、不改基期。

本輪假設：將觀測與進場暫停分開，可讓後續浮盈回吐及回撤研究保有資料。成功判定是 STOP 與交易日誌維持原樣、watch 停止時報告仍按時更新；這是資料完整性改善，獲利效果另由實際策略成交判定。

驗證：309 項 JS、155 項 Python、110 檔案語法與設定檢查通過；原生隔離 dry-run 開倉／平倉 smoke 通過。實際在現貨無 watch 且存在專用測試 STOP 時，UTC 23:56:46 的新版 supervisor 自動刷新兩份報告、STOP 未變。兩個交易引擎與合約 watch PID 保持不變。完成後僅移除這次專用測試 STOP 並恢復現貨。

## 下一轮待驗證的退出假設

`local/v6-exit-hypothesis-2026-09-11.json` 顯示：12 筆已平倉 v6 中，8 筆有觀測到正浮盈後最終虧損。只有 3 筆曾達到進場保存的 1 USDT 風險預算的一半，其中 2 筆最終虧損；有觀測空缺者已逐筆標示。這支持研究獲利保護，但不能把門檻計數換算成假想成交收益。

下一輪優先檢驗「淨浮盈達初始風險預算的 0.5 倍後，將原生停損收緊至含費用的保本位置」。0.5 倍是預先登記的單一風險比例候選，並非歷史最佳化參數；同時記錄提早退出造成的少賺、滑價和再次進場成本。保持進場條件、初始停損／目標、倉位預算相同，只比較這一項改動。需新版本、原生多空／費用／價格精度／重啟維持停損測試及新單 Demo 成交验证后才能判断效果。

**狀態：退出候選尚未啟用，當前仍是 v6。** 本輪先修復持續觀測與恢復現貨，不回頭修改已存在的 #24 退出計畫，也不以 12 筆與缺漏路徑選定最優參數。後續定期檢查以本文件及真實平倉結果接續，不把 30 筆參考當作交易額度。

原生實作方向採官方支援的每輪 `custom_stoploss` 及交易所停損更新，而不是用回測 K 線高點當作實際成交。[Freqtrade 官方 callback 說明](https://www.freqtrade.io/en/stable/strategy-callbacks/#custom-stoploss)。

## 證據檔案

- 完整帳戶讀取：`local/demo/heartbeat-history-2026-09-11.json`、`local/demo-futures/heartbeat-history-2026-09-11.json`。
- 本輪起始資料：`local/heartbeat-audit-2026-09-11-start.json`。
- 暫停採樣實測：`local/paused-evidence-live-proof.json`；守護重啟前程序：`local/paused-evidence-restart-before.json`。
- 測試：`local/paused-evidence-js.log`、`local/paused-evidence-python.log`、`local/paused-evidence-syntax.log`、`local/paused-evidence-native.log`。
- 最終狀態：`local/heartbeat-audit-2026-09-11-final.json`。所有報告依自身時間解讀，持倉浮動損益隨後會變動。
