# 交易機器人可借鑑設計與退出比較

2026-09-09。獨立 binancetrade，feat/trading-dashboard；只適用 Demo。

## 網路研究：工具存在不等於策略有獲利能力

- [Hummingbot PositionExecutor](https://hummingbot.org/strategies/v2-strategies/executors/positionexecutor/)：每筆持倉有預設止損、止盈、時間期限及追蹤退出。值得借鑑的是把執行與研究分離；持倉期限是待驗證參數，不是必然改善。
- [Freqtrade protections](https://www.freqtrade.io/en/stable/plugins/)：冷卻期、連續止損防護、回撤防護。若採用，須在我們的確定性 bridge 實際執行；不能假設 forceenter 自動遵循所有策略插件。本次沒有增加限制或修改額度。
- [Jesse charts](https://docs.jesse.trade/docs/charts/)：交易標記、累計績效、回撤、損益分布及基準比較。值得借鑑的是讓每筆決策可以追溯，而非只顯示勝率。
- [CFTC AI trading bot advisory](https://www.cftc.gov/LearnAndProtect/AdvisoriesAndArticles/AITradingBots.html)：保證高報酬、百分之百勝率及 AI 必勝宣傳是警訊。不能由此推論全部機器人都是詐騙，也不能用開源證明獲利。

## 本次實作

1. `src/reconcile.mjs`：不再以 stake 完全相等判斷未知進場。核對唯一交易與唯一 entry order ID、tag、商品、方向、模式、槓桿、完整成交、requested quantity 與數量精度，以及 gross quote cost。部分成交、價格偏移造成超額、缺欄位或無唯一證據仍 unresolved，不重送。不是自動修復所有未知訂單。
2. `src/report.mjs`、`src/position-context.mjs`：Freqtrade `fee_*_cost` 是報價幣金額，`fee_*_currency` 是支付資產；兩者不能組成原始佣金數量。新報表欄位 `engineFeesByQuoteCurrency`，原始佣金明細保持 unavailable；淨損益不再扣一次費用。分析提示版本 5。
3. `scripts/compare-exits.mjs`：只讀歷史與公開 Demo 一分鐘 K 線，不讀金鑰、不下單、不更新策略。輸出獨立 JSON，保存輸入、K 線、來源與 hash。

## 初次樣本結果（不是已實現收益）

輸入觀測：2026-09-09T03:37:00Z 左右；精確時間在 input-history.json。
證據：`local/exit-replay/2026-09-09T03-37-38-907Z/comparison.json`。
使用交易 2–7 共 6 筆；排除已知人工平倉交易 1，交易 8 尚未觀測完整 6 小時。
同樣歷史進場與規模、雙邊費用估計、退出額外滑價 5 bps（0.05%）：

| 候選退出 | 6 筆估計淨損益合計 USDT |
|---|---:|
| 固定 ROI／止損控制組 | -2.8662 |
| 加 0.8% 啟動、0.4% 跟隨追蹤退出 | +1.9934 |
| 追蹤退出＋120 分鐘期限 | -1.5782 |
| 追蹤退出＋240 分鐘期限 | -0.7696 |

判斷：值得繼續測試追蹤退出；不能据此認定策略獲利，也沒有證據支持直接把全部持倉限制為 2 小時。沒有部署新的時間退出。

重要限制：這是固定既有進場的退出敏感度測試，不是完整 AI 策略或投資組合回測。標準化持有數量與雙邊費率，非原始佣金／零碎餘額精算；第一根不完整分鐘跳過；每分鐘只模擬先高後低／先低後高兩種路徑，不涵蓋所有路徑；未退出者於最後完整分鐘估值，非真正退出訊號；不重算資金占用或後續模型决策。資料只有同一小段行情，且是改良時使用的樣本，尚未樣本外驗證。

重跑（Node 22+，先以本機只讀 report 更新歷史）：

```powershell
node src/cli.mjs report --mode demo
node scripts/compare-exits.mjs local/demo/trade-history.json --exclude-trade=1
```

驗證：87 項 JavaScript 測試、47 檔語法檢查、41 項 Python 測試通過；原生 Freqtrade dry-run smoke 通過，證據 `local/native-smoke/0c87262c-9fb9-4855-899a-521d7f91ef52/result.json`。沒有提交或推送 Git。
