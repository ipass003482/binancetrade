# 19 位原智慧體對 binancetrade 的意見

2026-09-14，台灣時間。已從本對話歷史核對原有 19 個子智慧體名稱，逐一喚回並收到本輪回覆。以下為各自意見的摘要；角色名称是其審查分工，名稱內的 v6 不代表本次仍在評估 v6。全部以現行 v11 為對象，未新增替代智慧體冒充原角色。

這些是同一專案證據上的分工意見，重複意見合併處理；提案仍需實際驗證。這輪沒有改策略、模型權重、交易參數、30 次目標或執行程序。

本輪統一帳務快照：台灣 12:41:37 現貨 0/30、合約 0/30；12:41:38 readiness 的 v11 兩模式皆零平倉。部分智慧體另讀了 12:04–12:47 的本地資料，其個別 asOf 保存在附錄，不把不同時間的預測統計混成同一筆。原始成交證據：[本輪目標報告](C:/Users/wuyaote/.openalice/workspaces/workspaces/chat-sunny-stone-arch/projects/binancetrade/local/trade-goals/2026-09-14-v11-30-each/reviews/2026-09-14T04-41-37-708Z-a84d0a27-6f78-48db-b21a-5b2efe48a4de/review.json)、[帳務報告](C:/Users/wuyaote/.openalice/workspaces/workspaces/chat-sunny-stone-arch/projects/binancetrade/local/readiness/2026-09-14T04-41-39-347Z-d89281df/review.json)。

| # | 智慧體 | 審查分工 | 意見摘要 |
|---:|---|---|---|
| 1 | execution_audit | 交易執行 | 逐單核對報價、成交均價、佣金與退出滑價；演練部分成交、逾時後成交及重啟，補上能核實的終態處置。 |
| 2 | evidence_audit | 研究證據 | 將預測到期淨值與真正退出淨利分列；等同批交易平倉後，按不重疊時段檢查績效，避免把同一段行情當成多份獨立證據。 |
| 3 | entry_contract | 進場條件 | 不要因成交少直接降低成本門檻；固定版本，記錄預測空間與實際費用、滑價、退出淨利，並保留被拒訊號的同期觀察。 |
| 4 | execution_review | 原生進場時效 | 在原生引擎真正下單前再核對模型期限與最新可成交價格；目前入口的計畫時限與 bridge 的模型期限不同，應測試排隊延遲和跳價是否會使優勢失效。 |
| 5 | forward_reporting | 前向績效報告 | 分開驗收 30 筆進場與有效平倉樣本；將事先預測的扣成本空間連接實際淨利及費用偏差，先回答模型優勢能否變成收益。 |
| 6 | native_probe | 端到端實測 | 既有驗證單只證明當時的執行路徑；v11 自然訊號出現後，追溯模型、成交、停損撤換到平倉，特別驗證淨利追蹤的保護線與實得金額。 |
| 7 | improvement_audit | 整體優化順序 | 把開發優先順序轉向證明模型是否有可交易優勢；固定 v11，先量測各階段通過率，再看預測到期後繼續持倉是否增加含費虧損，避免頻繁改版。 |
| 8 | wait_health_v6 | 監控與等待 | 增加驗證進度告警及零成交檢討窗口；把模型缺失、過期與一般 HOLD 分開，避免週期成功和故障數歸零掩蓋收樣停滯。 |
| 9 | native_protection_v6 | 停損與離線風險 | 補足長停機前的退出確認與獨立告警；量測換單空窗、停損限價與真正成交的落差，核對是否吃掉原訂回吐預算。 |
| 10 | portfolio_v6 | 共同本金與配置 | 提議為每個版本設累計虧損預算；同批交易平倉後，再按方向、幣種的扣費期望值、回撤與費用占比調整共同本金配置。 |
| 11 | pretrained_compare | 預訓練模型適配 | 另測與十五分鐘預測相符的持倉期限；模型評分也要單獨看通過成本篩選的訊號，全商品誤差平均不能證明選出的交易有優勢。 |
| 12 | learning_review | 成交資料與學習 | 補 v11 成交學習接線：現有學習器只接受 v9／v10，應連接模型指紋、預測雜湊、真實成交與費後損益，並分開評估預測誤差和持倉收益。 |
| 13 | final_model_audit | 模型有效性審計 | 先檢查模型訊號對應的實際淨利與滑價，再談模型增加收益或 alpha 衰退；當前少量誤差窗口落後基準，尚不能把表現不佳稱為優勢衰退。 |
| 14 | v11_execution_review | 模型下單流程 | 追蹤模型通過、報價複核、送單、成交各階段，區分預測不足、成本侵蝕與延遲失單；另測預測期限與持倉期限一致的版本。 |
| 15 | v11_native_contract | 原生退出 | 另立版本測試預測到期退出；逐筆比較移動停損的目標保護金額與實際淨利，記錄滑價、資金費與撤換延遲。 |
| 16 | v11_model_reporting | 模型成效報告 | 以模型指紋連接決策、成交與平倉淨利，使用同成本、同風控基準比較；價格預測誤差不能代替交易期望值。 |
| 17 | goal30_audit | 30次目標審查 | 30 次是收樣目標；同批交易平倉後，分現貨／合約、多／空檢查扣費期望值、連虧與回撤，中途改版另分組。 |
| 18 | goal30_report | 成交統計 | 把開倉進度連接已平倉樣本、扣費期望值與回撤；統計模型、成本、送單、成交各階段失去多少候選，定位改善環節。 |
| 19 | noon_model_health | 模型與資料品質 | 獨立測試十五分鐘退出；按合約商品统计 K 線修訂拒絕率，把資料被拒與有效預測選擇等待分開。 |

## 主責核對與取捨

1. **優先核對原生下單時效。** 主責已直接讀取 `RuleExits.py:entry_risk_allowed`：目前按計畫建立時間允許 120 秒；bridge 另在 HTTP 送出前檢查模型的第一分鐘期限。應讓真正原生下單時也能驗證同一模型期限與價格空間，並以延遲、跳價測試確認。這是已核對的契約差異，尚未有本輪實際成交證明因此出現損失。
2. **擴充現有診斷，不重做整套。** `src/entry-diagnostics.mjs:buildEntryDiagnostics` 已有基本 funnel、各候選拒絕原因及週期統計。代理提出的追蹤各階段通過率，應落在補上有效模型輸出、分開訊號／成本、原生接單／實際成交，以及模型缺失或過期的獨立健康狀態。
3. **補 v11 成交學習資料鏈。** 主責已核對 `learningRow` 只允許 v9/v10。v11 的模型與成交證據已有保存位置，應納入可驗證的逐筆資料，連到事先預測、實際費用及退出淨利。這不等於已訓練或已微調模型。
4. **以獨立實驗檢驗退出期限。** 十五分鐘預測和四小時最長持倉是不同設定；最長四小時不等於每筆一定持有四小時。是否縮短期限更有利，要靠分版的真實 Demo 比較，保留當前 v11 的目標與損失，不能把新版本成交混入舊組。期限問題不是零成交的直接證據。
5. **保留各 30 次進場目標。** 代理建議的有效平倉樣本、交易期望值及額外版本虧損預算是評估／風控提案，尚未變更現行設定；每日開倉次數仍不限。原有 100 筆／30 UTC 日／PF 1.2 研究門檻也未降低。

另核對一項較低優先度的設定一致性：`scripts/kronos-worker.py:consumer_integration` 不拒絕額外設定鍵，但 `src/model-entry.mjs:reviewedConfig` 要求恰好六鍵。当前設定吻合，這是後續避免誤報 configured 的建議，不能拿來解釋現在零成交。

## 個別依據

- **1. execution_audit**：asOf 2026-09-14T04:41:38.036Z。依據：`src/trading-costs.mjs:entryCost`、`src/reconcile.mjs:entryProof/reconcile`。
- **2. evidence_audit**：asOf 2026-09-14T04:41:37.708Z。依據：`src/pretrained_model.py:rolling_review`、`docs/demo-model-v11-2026-09-14.md`。
- **3. entry_contract**：asOf 2026-09-14T04:41:38.036Z。依據：`src/demo-rules.mjs:modelRuleDecision`、`src/trading-costs.mjs:entryCost`。
- **4. execution_review**：asOf 2026-09-14T04:41:38.036Z。依據：`src/bridge.mjs:execute`、`src/model-entry.mjs:assertModelOrderTiming`、`freqtrade/strategies/RuleExits.py:entry_risk_allowed`。
- **5. forward_reporting**：asOf 2026-09-14T04:42:51.932Z。依據：`src/demo-rules.mjs:modelRuleDecision`、`src/profit-review.mjs:buildProfitReview`、`src/forward-trial.mjs:buildForwardTrialReport`。
- **6. native_probe**：asOf 2026-09-14T04:42:51.932Z。依據：`freqtrade/strategies/RuleExits.py:_trailing_stop/custom_exit`、`src/demo-probe.mjs:probeFillEvidence`、`local/demo/forward-report.json`。
- **7. improvement_audit**：asOf 2026-09-14T04:41:37.708Z。依據：`src/demo-rules.mjs:modelRuleDecision`、`docs/demo-model-v11-2026-09-14.md`。
- **8. wait_health_v6**：asOf 2026-09-14T04:45:21.069Z。依據：`src/workflow.mjs:runCycle`、`local/demo/forward-report.json`、`local/demo-futures/forward-report.json`。
- **9. native_protection_v6**：asOf 2026-09-14。依據：`freqtrade/strategies/RuleExits.py:custom_exit/_trailing_stop`、`scripts/demo_protection.py:pin_demo_exit_config`。
- **10. portfolio_v6**：asOf 2026-09-14T04:45:49.655Z。依據：`src/portfolio.mjs:assessPortfolio/buildPortfolioReport`、`local/portfolio/report.json`。此為代理提案，尚未新增版本虧損限制；每日開倉次數仍不限。
- **11. pretrained_compare**：asOf 2026-09-14T04:46:39Z。依據：`src/demo-rules.mjs:modelRuleDecision`、`src/pretrained_model.py:rolling_review`、`local/model-research/review.json`。
- **12. learning_review**：asOf 2026-09-14T04:46:54.969Z。依據：`src/learning-evidence.mjs:learningRow/collectLearningEvidence`、`local/readiness/latest.md`、`local/model-research/report.md`。新增資料鏈不等於已重新訓練；現有凍結模型尚未微調。
- **13. final_model_audit**：asOf 2026-09-14 12:47（台灣時間；智慧體回覆只精確至分鐘）。依據：`src/pretrained_model.py:rolling_review`、`local/readiness/latest.md`。
- **14. v11_execution_review**：asOf 2026-09-14T04:04:50.151Z。依據：`src/bridge.mjs:64`、`src/demo-rules.mjs:173`。
- **15. v11_native_contract**：asOf 2026-09-14T04:40:54.575Z。依據：`src/strategy-contract.mjs:demoStrategyContract`、`freqtrade/strategies/RuleExits.py:custom_exit/_trailing_stop`。
- **16. v11_model_reporting**：asOf 2026-09-14T04:40:58.961Z。依據：`scripts/kronos-worker.py:diagnostic_scope`、`src/learning-evidence.mjs:collectLearningEvidence`、`local/model-research/review.json`。consumer_integration 未拒絕額外設定鍵，但 reviewedConfig 嚴格要求六個鍵，未來可能導致報告 configured 而入口拒絕；目前未改檔。
- **17. goal30_audit**：asOf 2026-09-14T04:04:48.593Z。依據：`scripts/trade-goal-review.mjs:buildTradeGoalReview`、`src/performance.mjs:evaluatePerformance`。
- **18. goal30_report**：asOf 2026-09-14T04:04:50.151Z。依據：`local/trade-goals/2026-09-14-v11-30-each/latest.json`、`local/readiness/latest.json`。
- **19. noon_model_health**：asOf 2026-09-14T04:06:06Z。依據：`src/strategy-contract.mjs`、`local/model-research/predictions/demo-futures/b99da3d2-b13d-47bc-a4aa-dfac007b047e.json`、`local/demo-futures/runs/9fae6223-3aab-4d4b-ba15-aca262077940.rules.json`。

機器可讀的逐位摘要：[agent-opinions-2026-09-14.json](C:/Users/wuyaote/.openalice/workspaces/workspaces/chat-sunny-stone-arch/projects/binancetrade/local/agent-opinions-2026-09-14.json)。
