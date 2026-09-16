# binancetrade 可靠性與績效驗收

2026-09-10。目標是建立可以查證、逐版比較的程式，尚不能判定穩定獲利。
本輪保留既有未提交修改，沒有提交／推送 Git，沒有自動恢復交易。

## 修改前先平倉

依使用者指示，先對三種本機模式寫入 STOP，再處理兩個正在運作的 Demo 引擎。
當時現貨有 ADA/USDT 交易 27；合約有 SOL/USDT:USDT 空單交易 14。
均透過原有 guarded bridge 平倉，之後核對成交紀錄、剩餘部位與掛單。

| 模式 | 平倉交易 | 確認時間 UTC | 引擎剩餘持倉／掛單 | 此筆引擎淨損益 USDT |
|---|---|---|---|---:|
| Demo 現貨 | ADA/USDT，27 | 2026-09-10 06:13:27.364 | 0 / 0 | -0.73946859 |
| Demo 合約 | SOL/USDT:USDT，14 | 2026-09-10 06:13:27.615 | 0 / 0 | -1.66129509 |

證據：`local/demo/operator-flatten-2026-09-10.json` 與
`local/demo-futures/operator-flatten-2026-09-10.json`。
另外執行既有唯讀 Demo 帳戶檢查：現貨 openOrders=0；合約 openPositions=0、openOrders=0。
現貨仍有零碎幣額；零程式持倉不等於帳戶每個非 USDT 資產餘額都是零。
default dry-run 引擎未連線，未啟動它來處理 Demo 部位。

## 本輪實作

1. **數字條件落實為程式檢查。** `src/entry-quality.mjs` 從完整、連續、已收盤的 15m K 線重算
   1h／4h 收盤報酬、SMA8／20 與相對前 19 根平均成交量；不信任模型回填指標。
   active 新進場不符合既有提示詞數值條件時，bridge 記錄 rejected／結果 filtered，不送單。
   filtered 是正常研究結果，不累積成三次系統故障。HOLD 與退出繼續可用。
   此門檻沒有把文字失效位當成掛單，也未聲稱已驗證突破確認或成本空間。
2. **送单前的暫停與版本核對。** `src/bridge.mjs`、`src/freqtrade.mjs` 在最後引擎身份讀取後
   再查 STOP 和策略指紋，所有非同步 preflight 之後重驗期限。
   已證明未送出的失敗記 rejected；送出後傳輸失敗仍 unknown，不盲目重送。
3. **持倉行情資料失效時禁止新增曝險。** `src/risk.mjs` 不再把引擎缺行情時的
   `total_profit_abs=0` 當作有效風險狀態；新進場要求現有持倉有效 current_rate 與 profit_abs。
   未更改既有 daily.closed + open-lifetime-PnL 計算，該值不是午夜至今帳戶權益變動。
4. **對帳精度修正。** `src/reconcile.mjs` 優先使用 Freqtrade 原始 `safe_price`，
   避免 `average` 八位小數捨入造成有效低價幣成交無法對帳。原始價格無效時不回退到有利數字；
   數量、完整成交、預算與 cost 容差均未放寬。
5. **策略版本與驗收。** `src/strategy-version.mjs` 保存進場時來源檔案雜湊、
   有效 policy、analyst profile 與觀察到的退出設定；透過精確 tag／snapshot id／有效時間歸因。
   缺少版本的歷史保持 unversioned，不冒充現行版本；磁碟來源不是程序已重載的證明。
   `src/performance.mjs` 與 `src/evaluation.mjs` 提供離線評估、版本分組和輸入完整性檢查。
   每個 evaluation 目錄包含精確原始歷史、SHA-256、版本對應、門檻與評估程式副本。

## 已觀察績效

現貨觀測：2026-09-10T06:21:45.343Z；合約觀測：2026-09-10T06:21:45.963Z。
以下是所有舊版本的成交描述，包含模型及操作平倉，不是本輪新版本績效。

| 指標 | Demo 現貨 | Demo 合約 |
|---|---:|---:|
| 已平倉 | 27 | 14 |
| 淨損益 USDT | 9.39242616 | 15.00686568 |
| 獲利因子 | 1.349901 | 2.340117 |
| 扣除最佳一筆後淨損益 USDT | -8.84196123 | 8.92038840 |
| 已平倉損益回撤 USDT | 10.92767471 | 6.48116621 |
| 首尾成交日跨度 UTC 日 | 3 | 2 |
| 本輪版本已平倉 | 0 | 0 |

現貨每側額外扣 5 bps 成交成本的假設情境：額外成本 7.8513346704 USDT，
剩餘淨利 1.5410914896 USDT。這是敏感度測試，不是實際新增費用。
合約交易 1、6、7 的成交記錄不完整，因此整體成本壓力情境標示 unavailable。
不以 margin × leverage 代替缺失成交金額。

證據：

- [現貨驗收](../local/demo/evaluations/2026-09-10T06-23-09-498Z-f3929770/evaluation.md)
- [合約驗收](../local/demo-futures/evaluations/2026-09-10T06-23-09-520Z-dac11433/evaluation.md)

兩種模式的現行版本均為 **insufficient_evidence**。正淨損益與高勝率都不能單獨推出穩定獲利。

## 驗證

- `npm test`：139 項通過；包含暫停競態、來源變更、行情缺失、多空方向、指標捨入、
  對帳、錯誤歸因與離線評估案例。
- `npm run check`：61 個 JavaScript 檔案與設定檢查通過。
- `npm run test:python`：42 項通過。pytest 快取寫入出現 Windows 權限警告，測試本身通過。
- `npm run test:native`：獨立 dry-run 買入、賣出、HOLD、報表流程通過，結束持倉 0、真實訂單 0。
  證據 `local/native-smoke/e1cc3f73-d3fc-4a2a-9754-19959d95762b/result.json`。
  此連線測試只替換進場訊號品質評估，以免測試結果取決於當時市場趨勢；
  帳戶、模式、數量、曝險、期限、送單與對帳保護維持原值，獨立測試涵蓋真實品質 gate。
- `git diff --check` 通過。

## 尚未具備的獲利證據

這個程式的進場由外部模型產生，原有 Freqtrade 策略 entry trend 是零，
不能把只回放固定進場的退出比較稱為完整策略回測。
目前未具備同版本長期前瞻樣本、跨行情階段的樣本外回測、連續帳戶權益／資金流、
完整原始交易所費用 ledger 或完整 futures 成本資料。

`config/evaluation.json` 的 100 筆／30 UTC 日／PF 1.2 等數值只是明示的初步研究門檻，
不能靠降低門檻使策略看起來通過，也不是統計顯著性保證。
目前不宣稱已達 10% 或任何百分比帳戶回撤目標；缺少對應權益資料便保持 unavailable。

下一個可比較實驗應先固定程式、提示詞、風控和退出版本，再記錄前瞻結果；
變更後另起版本，保留未知與失敗。現貨支援買入／賣出已持有資產；合約支援多空。
借幣現貨做空需要另一套借貸、利息與還款管理，目前未實作。
本輪结束時 STOP 維持啟用，沒有重新啟動研究 watch 或恢復開倉。

方法參考：[Freqtrade 回測假設與費用](https://www.freqtrade.io/en/stable/backtesting/)、
[未來資料偏誤檢查](https://www.freqtrade.io/en/stable/lookahead-analysis/)、
[現貨與做空／槓桿模式](https://www.freqtrade.io/en/stable/leverage/)。
