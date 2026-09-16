# 相對成交量 0.8 倍：外部資料與下一輪假設

2026-09-11，使用者要求上網查證 0.8 是否有依據、是否有更好的倍數。本輪為研究，未改動正在運行的 v8 或下單條件。

查到的資料沒有提供適用本專案「Binance Demo、5m、前 19 根均量、下一根確認、實際費用」的最佳獲利倍數。教學門檻、指標預設與實際策略績效必須分開。

## 外部證據

- [Binance Academy：Breakout](https://www.binance.com/en/academy/glossary/breakout)：突破時量能增加、收盤越過關鍵位、回測守住支撐／壓力，是不同的確認線索；沒有指定 0.8 倍，亦未提出本專案的下一根確認量門檻或費用後優勢。
- [TradingView：Relative Volume 算法](https://www.tradingview.com/support/solutions/43000635874-how-do-we-calculate-relative-volume-and-relative-volume-at-time/)：其一般 RVOL 使用前 10 根均量、排除當根；CEX 篩選器先把成交量換為美元。另有按歷史相同時點比較的方法。我們使用前 19 根基礎幣成交量均值，不能直接挪用網站篩選器的倍數。
- [TradingView 官方指標說明](https://www.tradingview.com/script/n0f50JKv-Relative-Volume-at-Time/)：1.0 表示等於過去均量；2.0 常作值得關注的固定門檻，但文中也稱固定門檻是任意選定，提供標準差或歷史區間等替代方法。高相對量表示活躍，不保證有方向或顯著價格移動。
- [IG：Relative Volume Indicator](https://www.ig.com/en/trading-strategies/what-is-the-relative-volume-indicator-and-how-do-you-use-it-when-230904)：以股票為例解釋 RVOL，部分交易者把超過 2 倍當作活躍訊號。這不是 Binance 5m 實測出的最佳倍數。
- [StockCharts：Flag, Pennant](https://chartschool.stockcharts.com/table-of-contents/chart-analysis/chart-patterns/flag-pennant)：其股票旗形範例呈現推進放量、整理縮量、再次突破放量。這支持區分不同階段研究量能，但不是下一根 5m 縮量就該買入的證據，不能把其週級形態直接套用本程式。
- [Freqtrade 官方策略文件](https://www.freqtrade.io/en/latest/strategy-customization/#entry-signal-rules)：範例用 volume > 0 避免無成交時段，不要求所有策略使用 RVOL 倍數；範例也不是已證明獲利的策略。不能據此刪掉成本或流動性檢查。
- [Hansen、Kim、Kimbrough：Periodicity in Cryptocurrency Volatility and Liquidity](https://arxiv.org/abs/2109.12142)：研究包含 Binance 的 BTC、ETH，發現星期、時段及小時內的量能與波動規律。這支持日後研究時段基準，不提供本程式 0.8／1／2 倍的排名。

## 本程式的具體問題

`src/demo-rules.mjs` 目前以最新確認 K 的量，除以該 K 之前 19 根的均量，要求至少 0.8；並未對前一根突破 K 單独設量能門檻。這兩種邏輯不同。

程式推論：如果突破 K 放量，它也進入下一根的比較均量，可能拉高確認 K 的門檻；因此「突破放量、下一根守價但縮量」可能被拒絕。反之，確認 K 的量高，也不能單獨證明突破 K 有量能支持。此為計算結構的解讀，尚未證明它造成淨損失。

## 建議的分步 Demo 試驗，尚未部署

1. 保留 v8 為對照，第一個探索版本只改量能檢查所在的 K：仍用 0.8，但檢查突破 K 相對其自身前 19 根均量；確認 K 檢查守住原門檻，保留有效且非零量、報價、成本、最小單位與其他風控，不另外要求確認 K 再達 0.8。單獨檢驗「量能應放在哪根 K」這項假設。
2. 若有足夠實際成交可比較，再在相同算法與同一種 K 的基礎上比較 0.8 與 1.0。1.0 的理由是均量基準，不是已知最佳收益；2.0 可列較嚴格的後續候選，但不能為引用熱門倍數而直接調高。
3. 判斷依据為分版本實際成交數、每筆扣費淨利、停損比例、費用、回撤、幣種和時段。被拒絕機會只能記錄為訊號，不能把未成交的後續價格變化記作收益。前後版本市場時段不同是比較限制，不能把差異全部歸因於門檻。

這是比任意換成 0.5 或追逐某個「最佳倍數」更清楚的試验設計。使用者本輪要求查資料，現行 0.8 和持續 Demo 均保留。
