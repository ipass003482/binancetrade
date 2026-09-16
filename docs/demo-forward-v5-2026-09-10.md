# 2026-09-10 Demo forward v5

截至 2026-09-10T11:49:22.484Z。技術開倉／自動平倉驗證完成；策略獲利驗證仍在收集真實 Demo 樣本，不能稱為穩定獲利。

## 已證實的問題與修正

- 舊版 v4 的 20 根突破、1h/4h 同向及量能至少 1 倍，使最近掃描全數 HOLD。這是條件不符，不能把沒有成交解讀成測試獲利。
- 原生 Freqtrade 會按最低交易額加 reserve 與固定 stoploss 預留；僅檢查 Binance raw minimum 不足。新增 Decimal 下單額檢查，與已安裝原生公式交叉驗證，並固定 adapter reserve=0.05。低於安全最低額則拒絕，不擅自加倉。
- 最新成本變化導致預估風險超過 1 USDT 時，bridge 只向下調整金額，重新檢查全部風控與最低數量，保存 requested/executed 差異。
- 未定送單仍阻止新單，不自動重送或猜測無成交。

## 本輪參數（尚未證明較好）

5m 收盤評估；前 12 根高低點突破 + 0.1 ATR5 緩衝；1h 同向必要、4h 只參考；量能至少前19根平均的 0.8 倍；SMA8/20 同向條件保留。出場使用已收盤 15m ATR：停損 1 倍（上限 2%）、停利 2 倍、最多 4 小時。每筆預估停損加成本預算 1 USDT；滑價與跳空可能使實際虧損超過此估計。成本空間、最大曝險、每日開倉次數和虧損限制均保留。合約 1 倍 isolated。現貨買入做多；做空由獨立合約模式提供。

## 真實 Demo 技術驗證

這是使用者授權的每模式 25 USDT 上限驗證單。purpose=execution_probe，專用版本 demo-execution-probe-v1；不列入策略績效。保留 Demo 身份、行情、時鐘、風險、費用、最低數量、停機及未定送單檢查。原生 stop/target=0.5%，90 秒觸發時間退出；實際成交約95秒完成，受引擎循環與交易所回應時間影響。

| 模式 | Trade ID | 方向 | 數量 ETH | 進場價 | 出場價 | 成交額 USDT | 淨損益 USDT | 進場訂單 | 出場訂單 |
|---|---:|---|---:|---:|---:|---:|---:|---|---|
| demo | 28 | 多 | 0.0101 | 2467.2 | 2468.53 | 24.91872 | -0.02393421 | 11763560650 | 11763601270 |
| demo-futures | 15 | 空 | 0.01 | 2466.05 | 2466.61 | 24.6605 | -0.02533064 | 16790086030 | 16790086803 |

合計淨損益 -0.04926485 USDT。兩筆均由原生 rules_time 自動平倉，已核對 exchange order_id、closed、filled、remaining 與實際費用計入後 profit_abs；未再重扣費用。數值來自專案 Freqtrade Demo 帳戶紀錄，不是回測。

- [demo 原始成交與驗證證據](../local/demo/probe-result-6924b72c-3c7f-4479-9107-2c326c6a4851.json)
- [demo-futures 原始成交與驗證證據](../local/demo-futures/probe-result-c479068e-8a11-40e8-946a-3548652a8cfb.json)

## 持續測試與後續

兩個 v5 引擎及 watch 已恢復。每5分鐘已收K評估一次，持倉由引擎持續管理退出；不保證每根K都有單。每分鐘更新本輪 forward 報告，儀表板分開新版策略、驗證單與全歷史。forward-trial.json 以精確 entry tag、開始時間及排除舊 trade IDs 固定本輪歸因。檢視指令：node src/cli.mjs forward --mode demo（或 demo-futures）。

每模式至少30筆有效策略平倉才做初步比較，這是採樣門檻，不是獲利保證。0筆不能調出已證實好的參數；先保留本版參數以觀測真實結果，根據費用、淨期望、勝率、盈虧比、虧損與退出原因判斷下一版。持續記錄拒絕原因，區分策略 HOLD、每日上限、無效資料與執行錯誤。

已建立每6小時的本對話檢查任務（automationId: binance-demo），檢查真實樣本、運行狀態及參數評估進度。既有一次性 05:00 任務是2026-09-09的 COUNT=1 歷史任務，未修改它。

本機運行需要電腦保持開機。Scheduled task 的執行條件參閱 [官方排程說明](https://learn.chatgpt.com/docs/automations?surface=app)；以實際任務執行紀錄為準。

## 驗證

214項 JavaScript 測試、96項 Python 測試通過；91檔語法及設定檢查通過。Python 僅有既有 pytest cache 權限警告。原生 Freqtrade dry-run 開/平倉 smoke 通過；上表是另外實際 Demo 成交的驗證。

## 19:50 台灣時間自動週期確認

2026-09-10 19:50:05 兩模式 watch 自行開始，19:50:11 各完成一輪，連續失敗數為0。最新查詢19:50:33均零持倉：上述驗證單已平倉，本輪策略條件未通過。下一輪19:55:05。現貨主要未通過SMA、1h方向或量能，NEAR未突破；合約依幣種未通過SMA、方向、突破或量能。這是保存的實际規則評估，不是推算盈虧。

- [現貨排程查核](../local/demo/v5-scheduled-check.json)
- [合約排程查核](../local/demo-futures/v5-scheduled-check.json)
