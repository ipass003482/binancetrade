# 現貨訂單流研究：先改善資訊，再驗證進場

研究日期：2026-09-15（台灣）。範圍：`order-flow-only-v1` 的現貨研究；未變更執行來源、帳戶、委託、持倉或參數。查閱了本專案 `AGENTS.md`、`docs/demo-flow-only-2026-09-15.md`、`src/order-flow.mjs` 與 `src/order-flow-collector.mjs`。以下是研究建議，不能視為已部署功能或已證實收益。

建議順序：先把目前每個判斷拆開量測，接著蒐集連續深度更新，最後用前瞻資料決定哪些資訊值得進入策略。不要因目前少數獲利交易修改 55%，也不要一次新增多項硬性限制，讓策略又無法進場。

## 現況與可確認的盲點

目前現貨以 60 秒主動買入成交金額比例至少 55%、三次 top-5 掛單金額不平衡均大於零、首尾中間價上升作為聯合條件；約 10 秒 REST 取樣、5 分鐘選取機會。這裡的 top-5 不平衡是**某時刻的存量**，不是新掛單、撤單、成交造成的流量。兩次 REST 快照之間發生又消失的變化無法還原。程式允許相同 `updateId` 重複取樣，三次快照也不能當作三個獨立支持訊號。

成交 `m=true` 表示買方是 maker，所以現有程式將其列為主動賣出是正確的。`aggTrade` 聚合的是同一 taker order 在同時間、同價格的成交；聚合筆數不能當作不同交易者或獨立押注數。[Binance Spot 串流定義](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md#aggregate-trade-streams)、[Spot API 詞彙](https://developers.binance.com/en/docs/products/spot/faqs/spot_glossary)

另一個需要驗證的假說是期限不匹配：現在使用約一分鐘的微結構資訊進場，但風險距離來自 15 分鐘 ATR，最長持有四小時。這不一定錯，但短期方向訊號不能直接證明有足夠持續性走到 3 ATR。ATR 目標大於成本是計畫的幾何條件，仍不是預期淨利。

## 建議 1：加入不影響下單的現貨影子診斷

從既有原始證據即可計算，不必先新增模型或調整進場門檻：

| 診斷 | 精確定義／用途 | 不應作出的解讀 |
|---|---|---|
| 最佳一檔不平衡 | `(bidQty - askQty) / (bidQty + askQty)`；與現行 top-5 金額不平衡並列 | 一檔和五檔同向不等於兩個獨立因子 |
| 加權中間價 | `(askPrice × bidQty + bidPrice × askQty) / (bidQty + askQty)`；同時記錄偏離 mid 的 bps、spread bps、spread/tick | 這個簡單公式應命名 `weightedMid`，不能冒充已訓練 Stoikov microprice，也不能當作可成交價 |
| 成交集中度 | 每筆聚合成交名目金額占比的最大值與平方和，總成交額、買賣額、時間分布 | 高買入占比可能由少數大單形成；但大單本身也不等於假訊號 |
| 判斷拆解 | 分別保存 tape、三樣本 depth、mid 是否通過，外加成本、風險、容量與資料失效原因 | 重疊原因不能相加成「被擋幾筆交易」 |
| 壓力與價格反應 | 保存買賣淨額／總額，以及相同時間窗內可觀測的 mid 變化；窗不一致時明記無法比較 | 高買入但價格停滯只能稱吸收候選；不能宣稱辨識大戶、冰山或操縱 |

若最佳報價是 `b<a`，以上 `weightedMid` 是兩者的凸組合，所以必有 `b≤weightedMid≤a`。對立即以 ask 買入的現貨策略，`weightedMid-ask≤0`；因此**不能新增「weightedMid 超過 ask 加成本才准買」這種永遠不可能成立的門檻**。

Stoikov 的研究 microprice 是根據訂單簿狀態估計未來中間價的模型，與簡單 weighted-mid 有區別；作者提供可研究的程式與樣本。這適合作為後續建模參考，現階段先量測即可。[原始論文](https://doi.org/10.1080/14697688.2018.1489139)、[作者程式庫](https://github.com/sstoikov/microprice)

**驗證方式：**診斷缺資料或計算失敗時僅留下原因，不改既有 eligibility、排序、委託或原生 guard。用已封存有效、缺欄位、過期、交叉盤證據驗證診斷狀態，並確認原有決策逐筆一致。這一步的收益是找得到問題，尚不是提高勝率的證明。

## 建議 2：建立 Demo 專用連續深度觀察器

使用官方 Demo market-stream host `wss://demo-stream.binance.com` 的 `@depth@100ms` 與 `@aggTrade`，並由 Demo REST 深度快照初始化本地訂單簿。只蒐集公開行情，與交易程式解耦；連線失敗不停止目前策略。官方定義包含更新 ID 連接、缺段後丟棄簿並重新同步、零數量刪除價位等規則。[Binance 本地訂單簿規則](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md#how-to-manage-a-local-order-book-correctly)、[Demo 對應網址](https://github.com/binance/binance-spot-api-docs/blob/master/demo-mode/general-info.md)

先在少量現貨白名單交易對量測，而不是同時改全部下單路徑。每筆保存交易所事件時間、接收時間、`U/u`、重連與缺段狀態、初始化快照 ID、原始批次及雜湊；資料保存設容量上限，超限記錄中斷，不能静默丟資料還宣稱連續。

可由同步後最佳 bid/ask 價量變化形成 `batchedQuoteOFI`，並以同窗平均深度正規化。100 ms diff-depth 是批次更新，不是逐一交易所事件：同批次內新增又撤除可能互相抵銷，無法精確分解每筆限價單、撤單或冰山補量。REST 三點差分也不能補成真實事件 OFI。

Cont、Kukanov、Stoikov 的原始研究發現，最佳報價供需變化的 OFI 與短期價格變化存在關係，且市場深度影響其價格效應；研究樣本是美股，不能直接移植成 Binance 勝率或成本後報酬。[原始論文](https://arxiv.org/abs/1011.6402)

**驗證方式：**測試重複、亂序、缺段、快照太舊、連線斷開、時間倒退及深度不足；只有連續區段可產生 OFI 觀察。對齊同時段 REST top-5 比較，分清接收延遲與真正簿差異。吸收只記為「大成交量但價格反應有限／反向且顯示深度補回」的候選形態，不作交易者身分或撤單動機判斷。

## 建議 3：以前瞻、扣成本的比較決定新參數

現階段保留當前策略作為比較基準。新特徵先影子蒐集，每個候選同時記錄訊號強弱、拒絕原因、可用資金／曝險、報價、資料時間與其後真實觀測價格。只在當時確實蒐集到未來價格後才能結算標籤；不能用不完整歷史補出「本來會成交」的獲利。

本輪固定觀測 1／5／15 分鐘的 mid markout 與 `futureBid / currentAsk - 1`，用來看訊號保留多久以及買賣價差影響。這些分鐘數是**研究觀測網格，不是優化好的交易參數**。再扣實際適用費率與明確的滑價假設作研究標籤；若未模擬委託成交、排隊和資金限制，就不能稱為交易淨利。正式比較仍以新版本實際 Demo 成交、完整費用與平倉結果為準。

最小可重現契約：

- 每個 anchor 保留 policy、pair、mode、snapshot／cycle ID、proof hash、原始 `sampledAt`、接收時間、bid/ask/mid、診斷值和三個固定 horizon；後续不得移動 anchor 或改 horizon 以挑選較好的反應。
- 在 `anchor+horizon` 之後取第一個有效前瞻觀測，觀測必須在預先固定的容許遲到時間內；記錄實際 elapsed 和 lateBy。容差應來自採樣間隔及收集延遲的工程設計，不能依收益挑選。過期、斷流、跨模式或資料錯誤標 `missing`，不補歷史、不插值、不拿目標之前的報價冒充到期值。
- 原始結果保存全部，但各 `pair+policy+horizon` 的非重疊統計，按時間固定選取 `anchor >= previousSelectedAnchor+horizon` 的樣本。15 分鐘 horizon 在每 5 分鐘採樣下最多約每三個 anchor 選一個；分母需列出原始、排除重疊、缺資料和有效數量。
- 同一 anchor 的 1／5／15 分鐘結果彼此相關；不同幣同一時段也可能相關。統計按 horizon 分開，另保留時段群集，不將所有 markout 的正值數量相加冒充獨立交易勝率。若估計不確定性，以時間區塊／日期為群集，不逐列假設獨立抽樣。

分交易對、spread/tick、時段與波動環境，採按時間前後分割的訓練／驗證，避免重疊 60 秒窗落在切分兩側。先比較目前 55% + 三樣本支持與少數預先登記的新假說；不掃大量門檻挑最好看的結果。需要報告訊號數、可執行候選數、真實成交數、平均淨利、虧損尾部、回撤和覆蓋率，避免用更少交易製造表面勝率。

排隊不平衡研究顯示，不同 tick 結構的預測能力可有明顯差異，支持按市場結構檢查而非替所有幣套一個「公開最佳值」。該研究的預測目標是下一跳 mid 方向，並不等於本程式多小時持倉的扣費獲利。[原始論文](https://arxiv.org/abs/1512.03492)

**升級條件：**候選能在未參與調參的後續資料改善扣成本的研究結果，且資料失效／執行風險沒有惡化，才以新的可識別政策前瞻部署 Demo。一次改一個主要假說，延續目前持倉原計畫、所有虧損與 2,000 USDT 基期。舊資料重算只列診斷；交易次數只算實際 entry fill。現有長期驗證門檻不因這份研究放寬。

## Demo 與實盤資料的界線

官方說明 Demo 的價格與訂單簿與實盤相似，但不等同真實市場資料；其訂單簿價格、圖表及成交可不同。故這裡的 OFI／成交吸收都是 **Demo 場域觀測**，既不能聲稱看到實盤資金，也不能以 Demo 成功等同實盤可複製。[官方 Demo 技術說明](https://github.com/binance/binance-spot-api-docs/blob/master/demo-mode/general-info.md)、[官方 Demo 使用說明](https://www.binance.com/es-MX/learn/binance-demo-trading)

未來若另研究實盤公開行情，應獨立紀錄 `environment=production_public_observation` 並只讀，不與 Demo 原始 proof、成交或收益混成一個樣本。這份研究未連線實盤行情，未讀取任何金鑰，未進行任何帳戶或下單操作。

## 本輪結論

優先實作建議 1 的診斷，啟動建議 2 的獨立觀察，再按建議 3 升級；目前沒有資料支持直接把 55% 改成特定新數值。研究的具體價值是識別「哪個條件擋住可執行機會、哪類壓力真的有後續價格反應、反應是否活得比成本與執行延遲更久」。
