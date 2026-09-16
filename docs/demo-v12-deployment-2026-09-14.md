# v12 部署與首次真實 Demo 成交紀錄

本紀錄固定於 2026-09-14 的部署與初期成交證據，最新引用的計數快照為 **09:35:51.671Z／台北 17:35:51.671：現貨 1/30、合約 1/30，兩筆均尚未平倉**。原生保護亦已分別核對通過。下文保留 09:31 首次快照，並另列 09:35 更新；它們不是稍後即時持倉或損益報告。策略定義見 [v12 策略文件](demo-model-v12-2026-09-14.md)。

09:39 已完成 bridge 正常複查分類修正並恢復 watch／supervisor；本文件涵蓋的最新有效部署 manifest 是 [recheck running.json](../local/v12-entry-recheck-2026-09-14/running.json)。原首次部署 manifest 仍保留作歷史證據，修正細節見文末補記。

## 已證明的部署

部署歸檔根目錄為 `local/v12-deploy-2026-09-14`：

| 證據 | 固定時間 | 已記錄事實 |
|---|---|---|
| [archive.json](../local/v12-deploy-2026-09-14/archive.json) | 09:26:34.810Z | 保存切換前歷史、退出計畫雜湊、共同資金基期與舊版本資料。 |
| [source-deployment.json](../local/v12-deploy-2026-09-14/source-deployment.json) | 台北 17:27:27.780725 | 部署 `kronos-direction-v12`、`demo-rule-exits-v12`、`kronos-native-entry-v2`，保存來源副本及 SHA256，`modelPinUnchanged=true`。 |
| [ready.json](../local/v12-deploy-2026-09-14/ready.json) | 09:28:21.766Z | 已核對新版本與獨立 goal；現貨排除既有 56 個 trade ID，合約排除既有 34 個 ID，當時均零持倉；`oldPlansAndBaselinePreserved=true`。 |
| [running.json](../local/v12-deploy-2026-09-14/running.json) | 09:28:51.699Z | 兩模式原生版本均為 `demo-rule-exits-v12`，均 STOP=false、未決提交 0，舊退出計畫／共同基期保留。 |

`running.json` 保存的原生程序為現貨 owner PID 9200／child PID 25544，合約 owner PID 22524／child PID 6512；這是當時身分證據，不能據此宣稱稍後 PID 不變。模型指紋全程仍是 `0bc0a246933d625d8c7724347a0dcc8cf8619d3646f46565558607b6a0cf96d1`。本轮沿用原模型與原生風險／退出規則，没有把預測或 ATR 空間記入收益。

共同實驗仍以原 2,000 USDT 為基期；部署前與 ready/running 的原基期淨損益記錄為 **-11.98755571 USDT**，未歸零。原 v11 goal、review 與舊 forward trial/report 已保存；新 v12 goal 起點為 **09:28:24.654Z**，只將新 v12 真實策略開倉成交計入現貨、合約各 30 次，沒有期限或每日次數上限。

## 部署驗證結果

本次首次部署前的 [JavaScript 日誌](../local/v12-deploy-2026-09-14/js-tests.log) 為 **441/441 通過**，[Python 日誌](../local/v12-deploy-2026-09-14/python-tests.log) 為 **469 通過**，[語法／設定檢查](../local/v12-deploy-2026-09-14/syntax.log) 為 **127 檔通過**。Python 另記錄一項 pytest 快取寫入權限警告，沒有測試失敗。

[原生 smoke](../local/v12-deploy-2026-09-14/native-smoke.log) 通過，模式明確為 `dry-run`，`realOrders=0`；其開平倉不列入 Demo 策略目標。隔離證據為 `local/native-smoke/f029744b-0fb1-46a4-80dd-b431e6760759`。這些測試證明所測執行契約與相容性，不是獲利證明；後續 bridge 修正的另一批測試與部署版本分列於文末。

## 17:30 首輪：合約實際成交、現貨未下單

完整首次週期資料與來源 SHA256 見 [first-cycle.json](../local/v12-deploy-2026-09-14/first-cycle.json)。

合約 snapshot `3d9e2d6a-0af2-454c-992f-67f7a88013c7` 選擇 `ETH/USDT:USDT` 做空。三根預測收盤價皆低於起始收盤價 2516.19，最後預測 2512.490966796875 也低於可成交 bid 2518.19；同輪完整成本與 ATR 目標檢查通過。當輪預測 SHA256 為 `ca9043504ab3fd61885dd8202118b7d1384a61a273a3264602f77aa4ff7be370`。

真正的成交證據來自固定 [09:31:08Z goal review](../local/trade-goals/2026-09-14-v12-30-each/reviews/2026-09-14T09-31-08-642Z-b7b8f748-dc22-40a3-bb2b-b6dfec063715/review.json) 與其 [完整 input](../local/trade-goals/2026-09-14-v12-30-each/reviews/2026-09-14T09-31-08-642Z-b7b8f748-dc22-40a3-bb2b-b6dfec063715/input.json)：

- trade ID **35**，方向 **short**；host tag 為 `codex-af97144c0ac4c944680d6dcf6f7fdb45`。
- entry order **16794147586**，`status=closed`、`remaining=0`、`filled=0.059`，於 **09:30:26.041Z** 成交。
- 成交價格 **2518.19 USDT**、數量 **0.059 ETH**、訂單 `cost`／持倉 `stake_amount` **148.57321 USDT**。
- review 當時該持倉仍開啟，因此它是一次真實 Demo 開倉成交，不是已平倉獲利，也不是僅 submitted 的委託意圖。

現貨 snapshot `a8e5beb1-564b-4b8c-afda-abf0a87ee8c4` 初選 `DOGE/USDT`。原 ask 0.08413 尚低於最後預測 0.08419093489646912，但送單前新 ask 已升至 **0.08424**，不再符合 v12 的正向可成交價格條件，當輪沒有訂單請求。原 outcome 在 **09:30:22.566Z** 記為 `failed / RULE_SIGNAL_REJECTED`；這是將正常市場條件消失錯分為操作故障的 bridge 狀態分類問題，並非應繞過的價格檢查。

**09:31:08.642Z 的首次歷史快照**為下表；09:35 的新增現貨成交另列後節，現貨並非持續為零：

| 模式 | v12 已成交／目標 | 當時持倉 | 當時已平倉 | 證據狀態 |
|---|---:|---:|---:|---|
| 現貨 | 0 / 30 | 0 | 0 | collecting，完整 |
| 合約 | 1 / 30 | 1 | 0 | collecting，完整 |

本文件不把這個首次快照延伸為稍後狀況，也不補寫即時浮動損益。舊虧損與本輪成交分開歸因。

## 17:35 更新：現貨 UNI 也已實際成交，兩模式各 1/30

固定 [09:35:51.671Z goal review](../local/trade-goals/2026-09-14-v12-30-each/reviews/2026-09-14T09-35-51-671Z-8a3be14b-375d-4933-bf43-0c804ca5b9cf/review.json) 已確認現貨 `UNI/USDT` 做多 trade ID **57**，entry order **475888586** 於 **09:35:21.143Z** 成交；合約 ETH 做空仍為 trade ID **35**。兩模式計數與損益證據完整，狀態均為 `collecting`。

| 模式 | v12 已成交／目標 | 當時持倉 | 當時已平倉 |
|---|---:|---:|---:|
| 現貨 UNI 做多 | 1 / 30 | 1 | 0 |
| 合約 ETH 做空 | 1 / 30 | 1 | 0 |

[09:35 operations 證據](../local/trade-goals/2026-09-14-v12-30-each/operations-2026-09-14T09-35-55-508Z-a03eb29e.json) 記錄兩模式 `protection.verified=true`：現貨於 09:35:52.165Z、合約於 09:35:54.678Z 核對原生停損，分別對應 trade 57／35；兩模式均為 `demo-rule-exits-v12`、STOP=false、未決提交 0，當時部署來源未變。模型與 watchdog 心跳亦通過相同 pin 的可用性檢查。

這次更新只證明兩模式均已真實 Demo 開倉及原生保護成立，不宣稱已平倉獲利；稍後行情與損益仍須用新快照確認。原 17:30 DOGE 的價格檢查及錯誤分類紀錄保持原樣，不因後來 UNI 成交而刪除。

## 17:39 補記：bridge 正常複查分類已修正並部署

DOGE 暴露的分類問題已修正。送單前有效新報價使 `MODEL_FORECAST_ALREADY_PASSED`，或有效新成本使 `BASELINE_PRICE_SPACE_TOO_SMALL`，現在記為正常 `filtered`／不下單；其他無效來源、模型證據、時鐘及風險錯誤仍拒絕執行。這次沒有放寬進場、成本或風險參數，也不強制成交。09:30 原 `failed / RULE_SIGNAL_REJECTED` outcome 保持原文，不回寫為成功。

[修正來源部署紀錄](../local/v12-entry-recheck-2026-09-14/source-deployment.json) 記錄 09:38:04.397835Z 部署，`src/bridge.mjs` SHA256 為 **`368b87de425665c1c7689f2620352a758a71f8a754bb6c837e739ef79e52f0b6`**。09:39:31Z 恢復 watch／supervisor；[09:39:33.670Z running manifest](../local/v12-entry-recheck-2026-09-14/running.json) 核對兩模式相同新 bridge 雜湊、STOP=false、未決提交 0，原生退出版本仍為 `demo-rule-exits-v12`。

這次只重新載入 watch／supervisor，原生引擎、核心模型、horizon lab 與 model watchdog 均保留既有程序；模型 pin 不變。goal、forward trial、共同基期與所有原退出計畫不改寫。[validation.json](../local/v12-entry-recheck-2026-09-14/validation.json) 明確記錄 `goalAndTrialBaselinePreserved=true`、`strategyParametersChanged=false`、`historicalFirstSpotFailureRetained=true`；其部署來源清單涵蓋 **62 檔**，副本保存在同目錄 `deployed-source`，該目錄另保存修改的測試檔。

修正後 [JavaScript 測試](../local/v12-entry-recheck-2026-09-14/js-tests.log) 為 **444/444 通過**，[語法／設定檢查](../local/v12-entry-recheck-2026-09-14/syntax.log) 為 **127 檔通過**。Python 來源沒有變更，沿用本次首次部署 **469 項通過**的證據，不宣稱另跑一輪 Python。新的 [原生 smoke](../local/v12-entry-recheck-2026-09-14/native-smoke.log) 通過，`realOrders=0`，隔離證據為 `local/native-smoke/eb192cad-5723-4f9d-a546-c914d5584628`；它不計入兩模式各 30 次 Demo 目標。

本補記證明修正與受控重新載入完成；恢復後每個新週期仍以各自不可變 outcome 與實際成交證據判定，不能把測試或重新啟動當成新成交。零成交本身仍不是模型停止條件。

## 17:45 最後核對：現貨 2/30、合約 1/30

[09:45:45.331Z 實際成交報告](../local/trade-goals/2026-09-14-v12-30-each/reviews/2026-09-14T09-45-45-331Z-bd932675-8600-4e45-bbcb-3bed81a03150/review.json) 確認現貨新增 XRP trade 58，連同 UNI trade 57 共 2/30；合約 ETH 做空 trade 35 為 1/30。三筆都未平倉，當時合計浮動淨損益 -0.59181812 USDT，已實現為 0。這是固定觀測值，後续以最新帳戶資料為準。[三筆原生保護核對](../local/trade-goals/2026-09-14-v12-30-each/operations-2026-09-14T09-45-49-716Z-938a75c1.json) 全通過，未決提交為零、兩模式 STOP=false，新來源雜湊符合。

[17:40 真實週期](../local/v12-entry-recheck-2026-09-14/first-cycle.json) 已驗證 NEAR 報價超越預測被記為 completed/filtered，故障次數為 0。合約同輪補充輸入全部不可用，沒有製造預測；後續逾時紀錄保留，不能把它解釋成推論速度變慢或任意放寬資料驗證。

切換期間模型保持運行；其後 **17:43:20.538** 發生獨立 MODEL_OPERATION_FAILED 退出，**17:43:31.508** 既有 watchdog 證明程序不存在後自動封存並恢復同 pin。這次復原與 17:40 合約輸入失敗分開，沒有手動重啟、清除預算或修改 pin。完整未發佈 status tmp 仍在，精確 Windows 錯誤未明，不能宣稱根因已修復。[故障與自動復原證據](../local/v12-entry-recheck-2026-09-14/primary-recovery.json)、[程序核對](../local/v12-entry-recheck-2026-09-14/process-validation.json)。

17:45 已重新產生現貨 10/10、合約 3/4 的有效新預測；合約 ETH 當輪因 MODEL_PROVIDER_CANDLE_REVISED 排除，既有 ETH 持倉退出不受影響。watchdog 回到 healthy，現貨 XRP 實際成交證明新推論再次進入完整下單鏈。合約同輪 HOLD 是正常新決策。模型/lab/watchdog/native 的責任與可用性分開記錄，不以 completed HOLD 取代模型健康證據。[最後狀態](../local/v12-entry-recheck-2026-09-14/final-state.json)。
