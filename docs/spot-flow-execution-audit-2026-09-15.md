# 現貨訂單流收集與執行獨立審計

審計時間：2026-09-15 14:02–14:05 台灣時間。審計對象為部署中的 `order-flow-only-v1`、`sampled-demo-flow-v1`、native guard v8。這份報告只研究現行程式和保存的真實資料；合成測試使用假 fetch、沒有連網交易、沒有修改交易來源或門檻。

## 結論

找到兩項可重現的收集器時間缺陷，以及一項取樣排程脆弱點。它們值得修復，但本次檢查的 370 個現貨幣對快照沒有出現這兩類超時，不能稱為今天少成交的主要原因，更不能稱為修好後已提升獲利。兩筆現貨平倉不足以重新擬合勝率參數。

## 1. 共用成交窗尾，會使後排幣對自行過期

來源：`src/order-flow-collector.mjs:9–21`。整輪先抓一次 `serverTime`，10 個現貨幣對以 3 路並行分批查詢，但所有幣對的 `endTime` 都固定為同一個 `serverTime - 1500`。

`src/order-flow.mjs:34` 和 `scripts/demo_order_flow.py:52` 正確要求最新深度與成交窗尾相距最多 5 秒。後排請求花的排隊時間會被直接算入這個差距。即使每個請求都在 3 秒 HTTP timeout 內，最後一批也可能僅因先前幣對延遲而拒絕。

合成重現：10 幣對、3 路並行、每個深度和成交請求各 1100ms，同側三本深度、主動買流、上升中間價完全相同。

| 幣對所在批次 | 實際 book.at − endTime | 結果 |
|---|---:|---|
| 第 1 批，3 幣對 | 2615–2617ms | eligible |
| 第 2 批，3 幣對 | 3726–3727ms | eligible |
| 第 3 批，3 幣對 | 4838–4840ms | eligible |
| 第 4 批，1 幣對 | 5943ms | FLOW_STALE |

建議修法：每幣對開始查詢時，以本輪已校準的 server clock 加上實際經過時間，分別凍結自己的 60 秒窗尾；同一幣對的窗尾一旦確定就不能在回應後追改。仍然要求 `endTime <= 真實 depth 接收時間` 且差距 <= 5000ms，保留所有時效限制。

必要測試：上述 4 批延遲重現、時間 API RTT 超標、正負 clock offset 邊界、請求中途時鐘跳變。注意目前 clock 容许 server 比本機快 2000ms，但窗尾只減 1500ms，這種極端偏移可能導致窗尾落在本機深度時間之後；應繼續拒絕，不能以移動 book.at 或刪去 `endTime <= book.at` 修飾證據。

## 2. 深度時間被慢成交 API 回應向後延移

來源：`src/order-flow-collector.mjs:19–24`。`book.at` 在 `Promise.all([depth, aggTrades])` 整體結束後才指定。若深度先到、成交後到，深度在本機已經存在多久會被少算。

合成重現：單幣對 depth 等待 100ms，aggTrades 等待 2700ms。深度真實接收時間為 1789452208760，保存的 book.at 為 1789452211364，相差 **2604ms**；該證據仍 eligible。這會偏移三次深度間隔、最新樣本年齡及深度／成交窗對齊，屬於時間證據不準確。

建議修法：在 depth 自己的 promise 完成時立即捕捉接收時間；整体回應結束的時間另供審計，不得拿來替代深度時間。保留原始價格、數量、更新 ID，不重新標時間。

必要測試：depth 快／trade 慢、trade 快／depth 慢、不同幣對不同完成順序；確認保存時間是 depth 回應完成時，而不是整批完成時；native 與 JS 應對同一證據同樣接受或拒絕。

## 3. 取樣間隔目前是工作耗時再加 10 秒

來源：`src/order-flow-collector.mjs:35–45`。下一個 timer 在整輪採樣與寫檔完成後才排 `10000ms`。因此實際間距不是固定 10 秒，是 10 秒加工作耗時；慢輪次接近或超過 10 秒會觸碰 validator 的最大 20 秒間隔。

建議修法：扣除本輪工作耗時，避免累積漂移，但不能立刻補跑。簡單 `max(0, 10000 - elapsed)` 在「前輪耗時 9 秒、下一輪很快」會使最後一個幣對的下一次樣本只隔約 1 秒，反而違反最小 5 秒。可保留至少 5 秒輪次間隔，或以每幣對上次 depth 時間限速；不得虛構時間、重放趕進度、放寬 validator 的 5–20 秒。

必要測試：慢→快、快→慢、計時已過期、429／418 退避、STOP、採樣中停止。過長輪次導致證據不連續時應重新累積三個有效樣本。

## 4. 真實保存資料的範圍與限制

以快照 `createdAt` >= 2026-09-15T02:56:58Z 篩選 `local/demo/runs/*.snapshot.json`，於 2026-09-15T06:02:03.836327Z 檢查：37 個快照、每次 10 幣對，共 370 個原始 flow proofs。

- 最早：2026-09-15T03:00:08.143Z，`local/demo/runs/88700777-afd0-48f1-a6d4-738e1d703efc.snapshot.json`。
- 最新：2026-09-15T06:00:08.118Z，`local/demo/runs/8d63f5e2-db29-4505-9ed2-d4c8b68d2c60.snapshot.json`。
- book.at − endTime 超過 5000ms 或負值：0。
- 三樣本間隔超過 20000ms：0。
- 缺少 orderFlow：0。
- 最大 book.at − endTime：3512ms；最大樣本間隔：11340ms。
- 1000 筆滿頁：BTC 1 次、ETH 3 次，共 4 次。其餘 8 幣對沒有滿頁。

這些數量只描述保存於每個 5 分鐘評估的快照，沒有保存下來的每 10 秒採样不在統計內。它們不代表交易成功率，不包含反事實獲利估算。

## 5. 满 1000 筆目前應保留拒絕，後續另做完整分頁

來源：`src/order-flow-collector.mjs:21`，`src/order-flow.mjs:17`，`scripts/demo_order_flow.py:24`。

目前只取一頁，`len >= 1000` 會拒絕。這是正確的資料完整性防線；直接讓 1000 通過會把可能被截斷的早段買賣比例當成整個 60 秒。

後續若改善繁忙時段可用率，应另設有總頁數、總筆數、整體 deadline 的分頁證据版本。可先按時間窗取首頁，再以最後 `a + 1` 往後查，保留到原始窗尾的資料、確認已越過尾部或取得非滿頁。必須驗證逐頁連續 ID、重複 ID 內容一致、時間排序、完整結束、429／timeout 拒絕，不能把頁數達上限當完整。需要新的完整性證据及 host/native 同步驗證，不能只提高現在 `<1000` 上限。

官方 Spot 定義 `fromId`、`startTime`、`endTime` 都含邊界，單頁最多 1000；資料來源為 Database：[Binance 官方 Spot REST 文件](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#compressedaggregate-trades-list)。

若共用到合約，官方特別指出 `fromId` 與時間範圍同送可能 timeout，建議擇一；合約每頁權重 20，不能忽略增加的請求負荷：[Binance 官方 Futures market data](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#compressed-aggregate-trades-list)。本次未實作或驗證分頁版。

## 成本、退出與 snapshot 檢查

`src/demo-rules.mjs:319–335` 目前以可成交 quote 作 ATR 分母，3 ATR 僅表示計畫退出距離。成本+30bps、扣成本 reward/risk 與現貨 native reserve 保留。`scripts/demo_model_guard.py:225–268` 和 `307–338` 在 native 邊界重新核對 evidence hash、價格／ATR、成本、風險與原始 flow 時效；本次未找到能以模型缺失、假成交或單純取消成本門檻合理修復的問題。

`src/research.mjs:42` 各幣對從 atomic 寫入的 cache 讀取，可能拿到相鄰採樣代的不同幣對，但每幣對自身的三樣本與成交窗仍原樣保存在不可變 snapshot 及 entry proof 中；目前方向條件是各幣對獨立，未發現因此錯把某個幣對資料冒充另一個的路徑。若未來計算跨幣對共同因子，應一次釘住整輪 cache 代次。

現貨原生 stop-limit 及浮盈 trail 都不保證成交在理想淨利 floor。本次不改停損、trail、stake、55% 或三深度支持門檻；用足夠新成交、實際手續費與實際滑價檢驗，不能從兩筆獲利推論參數已優化。
