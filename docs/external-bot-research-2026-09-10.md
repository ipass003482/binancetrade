# 公開自動交易機器人：做法、績效與本專案可採用的方向

查閱日期：2026-09-10。這是公開文件與程式碼審閱，沒有重跑他人回測、驗證其私人交易所帳單或安裝外部策略。主辦方／作者自報、回測、公式檢查與本人的判斷分開列示。

## 主要結論

公開資料確實有賺錢案例，也有虧損案例；本次未找到足以證明「小本金、同一公開策略、長期實盤扣除全部成本仍可穩定翻倍」的紀錄。值得採用的是可重現的研究及交易驗證流程。對本專案，先補新倉成本資料、完整權益回撤與可回放的進場規則，優先度高於增加模型複雜度。

## 別人怎麼做

| 路線 | 可查核的做法 | 對本專案的判斷 |
|---|---|---|
| Freqtrade／NostalgiaForInfinity（NFI） | 在現成引擎上撰寫 Python 策略、配置商品與倉位，再執行回測及 dry-run；NFI 公開程式與測試配置 | 適合借鏡規則、版本與測試方式；不是直接替換正在跑的策略 |
| Hummingbot 做市／套利 | 市場資料、長期運行的 controller 與負責下單／管理／退出的 executor 分層 | 我們的研究、bridge、引擎已有類似分工；做市還需要額外的庫存與雙邊成交風險管理 |
| 交易所網格 | 配置上下限及網格間距，低買高賣配對 | 必須同時計入未配對持倉損益，不能用完成網格的正利潤代表帳戶獲利 |

來源：[NFI 原始專案](https://github.com/iterativv/NostalgiaForInfinity)、[NFI 安裝與回測配置](https://iterativv.github.io/NostalgiaForInfinity/installation-and-setup/)、[Hummingbot 架構](https://hummingbot.org/strategies/v2-strategies/)、[Binance 網格參數](https://www.binance.com/en/support/faq/detail/688ff6ff08734848915de76a07b953dd)。

## 公開績效案例及限制

### NFI：高收益數字來自回測

文件中標題為 2024 Global Summary 的現貨頁，列出 10,000 USDT 起始回測資金、289 筆交易、3,123.95 USDT 利潤、平均勝率 96.95%、平均回撤 1.12%。合約頁同為 10,000 USDT 起始回測資金，列出 362 筆、36,262.03 USDT 利潤、平均勝率 97.68%、平均回撤 3.13%。兩頁均明確標示模擬環境。

這些是作者公布、尚未由本次研究重現的數字。頁面又寫跨年份／月份彙總，與 2024 標題的期間口徑不清；平均回撤也不是整段帳戶最大回撤。因此不把它們換算成可比較的年化報酬或實盤預期。

來源：[現貨回測摘要](https://iterativv.github.io/NostalgiaForInfinity/backtest-results/binance-spot/summary/)、[合約回測摘要](https://iterativv.github.io/NostalgiaForInfinity/backtest-results/binance-futures/summary/)。

### Hummingbot：短期比賽有盈有虧，公開 Profit 不是完整淨利

2023 年 9 月舉行、10 月 12 日發文的 Beta Bot Battle 為期 48 小時。主辦方描述參賽者以約 100 USDT 或以下資金，在 Binance 現貨／合約交易。五位合資格參賽者公布的 Profit 依序是 +134.72、+11.24、-5.40、-1.00、-3.61 USDT。這是主辦方根據參賽者上傳 CSV 計算的短期成績，沒有本次獨立交易所查帳。

做法例子：第二名 WeGotGame 改寫做市腳本，以 NATR 波動率調整報價、止盈及止損；另有偏空配置及第二層加大訂單的馬丁格爾做法。後者不適合直接納入本專案現有不攤平限制。

來源：[主辦方結果與策略說明](https://hummingbot.org/blog/-beta-bot-battle-results-and-roundup/)。

本次程式碼核對發現：公開計算脚本把 Fees Paid 分欄列示，但 Profit 公式是賣出金額减買入金額，加上剩餘部位按最後成交價估值，沒有扣手續費。第二名公開表格列 Profit 11.24、Fees Paid 9.85 USDT；單純相減只剩 **1.39 USDT**。這是本次依表格推算，不是經查帳的最終淨利：尚未核對資金費、起始部位及最終清倉成本，剩餘部位也不是統一時點的可成交報價。

來源：[公開計算腳本](https://gist.github.com/fengtality/8970b8ce67bc84dc5047ab729922d44d)、[主辦方成績表](https://docs.google.com/spreadsheets/d/1ODmPtEOPmYRSpK9l0s0uey425VCVMI-G1eNpAFrWVmQ/edit)。

### 學術研究：历史有效仍可能在新期間失效

Hudson 與 Urquhart 的同儕審查研究（2021 年期刊出版，2019 年先行上網）測試近 15,000 個技術交易規則，報告樣本內存在獲利與預測能力；但 Bitcoin 在樣本外期間未保留預測能力。這支持跨期間驗證的必要性，不能當作目前某個幣或策略的推薦，也不是機器人的實盤收益。

來源：[作者所屬大學的研究摘要](https://research.birmingham.ac.uk/en/publications/technical-trading-and-cryptocurrencies/)。

### 網格顯示的年化與帳戶賺錢是兩件事

Binance 定義現貨網格總利潤為網格利潤加未實現損益。因此，完成配對的網格有正收益，帳戶仍可能因剩餘幣價下跌而虧損。頁面年化公式把短期收益依運行時間比例放大，不能解讀成已賺完一整年的報酬。這是指標定義，沒有提供所有使用者的勝率分布。

來源：[Binance 網格計算說明](https://www.binance.com/en/support/faq/detail/688ff6ff08734848915de76a07b953dd)。

## 對 binancetrade 的具體優先順序

下列是本次判斷及待實作建議，不是已完成修改：

1. **新倉成本資料。** 接入模式及商品相符、帶時間與來源的實際費率；把來回手續費、價差、估計滑點、合約資金費分開。`local/demo-entry-test-2026-09-10.json` 已記錄兩輪分析缺少雙邊費率；當輪同時有市場條件不符，不能說補費率就一定會成交。
2. **可重現的完整進場。** 現有外部模型決定進場，Freqtrade 的 entry trend 不自行產生進場，因此單獨回測引擎不能代表完整系統。先建立固定的趨勢／突破確認規則作為基準，再比較模型是否提高扣成本後績效；模型的版本、輸入和提案需保存。以新模型分析歷史資料還有模型可能知道歷史結果的問題，必須與真正前瞻 Demo 分開。
3. **把多、空分開驗收。** 比較現貨多單、合約多單、合約空單的費後淨利、完整帳戶最大回撤、曝險時間及成本；與同一期間、相近風險的簡單基準比較。
4. **保留未用於調參的時間段。** 做依時間推進的樣本外驗證、未來資料偏誤檢查，並用更差的滑點情境測試。Freqtrade 官方回測預設可在 K 線高低範圍內按要求價格成交、沒有滑點；漂亮回測仍要與 Demo 逐筆對照。[回測假設](https://docs.freqtrade.io/en/stable/backtesting/)、[未來資料偏誤檢查](https://docs.freqtrade.io/en/latest/lookahead-analysis/)、[QuantConnect 回測與實盤對照](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/reconciliation)。
5. **以完整帳戶損益檢驗 2,000 美元目標。** 淨利需排除入金，並計入浮虧、交易成本及程式運行成本；固定訂閱費不要直接冒充每單變動成本。先有同版本前瞻證據，再討論正式資金規模。

專案已有版本指紋、交易紀錄、費用壓力情境和初步驗收設定。`config/evaluation.json` 的 100 筆／30 UTC 日／獲利因子 1.2 是初步研究門檻，不代表通過就可保證未來獲利。此前全部舊版本 Demo 小幅正損益也不能歸因為現行版本的穩定優勢，詳見 [本地驗收紀錄](profitability-readiness-2026-09-10.md)。

本次只保存研究文件，沒有改動正在運行的交易規則或排程，沒有安裝外部策略。依專案規則未自動提交／推送 Git。
