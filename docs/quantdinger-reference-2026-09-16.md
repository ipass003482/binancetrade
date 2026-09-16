# QuantDinger 參考審查（2026-09-16）

## 結論

QuantDinger 值得參考的是可稽核的研究到執行流程、明確的進程邊界、統一的策略契約、回測成本假設、風控閘門、幂等下單與重啟後對帳。它不是已證明能穩定獲利的策略，也沒有在官方資料中提供可直接移植的公開獲利參數。這次只採用工程與驗證方法，不更換目前 Binance Demo 的訂單流進場政策。

## 官方資料中可確認的能力

1. **研究到執行的同一份策略契約。** Strategy API V2 讓同一份 Python 策略源碼和 manifest 同時服務回測與執行；universe、週期、預熱、方向能力及下單意圖由源碼聲明，執行面板不能任意改寫。
2. **可重現的回測診斷。** 回測結果保留實際成交、已平倉交易、訂單帳本、延遲／拒絕原因、持倉快照、權益曲線、回撤、勝率、Profit Factor、資料來源與執行假設。官方也要求測試多組手續費和滑價。
3. **成本與資金費的邊界。** 回測會扣手續費及滑價，但官方文件明確說 Crypto 資金費目前不在 Strategy API V2 回測中建模；槓桿 swap 的回測不能直接當成實盤淨利。
4. **執行可靠性。** HTTP、長期 trading worker、scheduler、有限背景工作及 migration 分開；PostgreSQL 保存持久狀態，Redis cache 與 durable job queue 分離；幂等鍵、租約、fencing token、WebSocket 加 REST 對帳用來防止重複執行和漏事件。
5. **訂單狀態不被假設為成交。** 新策略需要穩定 client order ID；`partial` 不算完全成交；只有終態和同步倉位同時確認後才推進週期或重用資金。
6. **觀測與權限。** 官方提供 JSON logs、request ID、Prometheus/Grafana/Alertmanager，以及 R/W/B/T 分離的 Agent 權限和 paper-only 限制。這些是運維與安全能力，不是收益證明。
7. **內建模板有明確風險。** 平台有 Grid、DCA、Trend Following、Martingale 等模板；文件明確要求限制預算、層數、槓桿和週期風險，並特別指出 Martingale 尾部風險很高。

## 對照目前 binancetrade

| QuantDinger 做法 | 我們目前已有 | 可安全移植的改進 |
| --- | --- | --- |
| 策略 manifest／版本指紋 | 目前有 ruleVersion、entryPolicyVersion、model fingerprint 和新 session | 把每次候選、回測／前瞻檢驗、部署來源綁到不可變 experiment manifest，避免混用版本 |
| trading worker 與排程分離 | Demo engine、flow watch、model/horizon、supervisor 已分開 | 保留分離；把關鍵狀態的 owner、租約、心跳、fencing 和恢復證據列成單一清單 |
| journal-before-send、穩定 client ID、對帳 | 目前有 orders journal、native protection、reconcile 與 unknown fail-closed | 再加一個跨現貨／合約共用的 pre-trade risk gate，統一檢查名義金額、曝險、價格偏離、資料新鮮度、速率和 allowlist |
| 同一模型回測與實盤 | 現有 Demo 是真實前瞻成交，研究與執行分開 | 建立 replay adapter，用與 Demo 相同的 signal、成本、保護和 fill schema 做 walk-forward；不要把歷史回放當成真實獲利 |
| order ledger 與成本壓力測試 | 已追蹤實際扣費損益、成交證據與未解決送單 | 增加 commission/slippage/funding stress 分組，對每個版本輸出淨優勢在成本上升後是否仍存在 |
| metrics、logs、alerts | 有本機 dashboard、JSON journals 與 heartbeat | 增加可查詢的 cycle latency、candidate→fill funnel、拒單原因、stale data、unknown、保護延遲和 PnL drawdown 指標 |
| 多模型研究 | model/horizon 目前獨立觀察，不阻擋 flow 下單 | 先做 confidence calibration、分歧度和前瞻方向正確率報表；在證據足夠前只作排序／診斷，不作強制批准者 |

## 不直接採用的部分

- 不把 Grid、DCA 或 Martingale 當成「更容易獲利」的替代策略；它們改變的是資金配置與持倉路徑，不能消除市場方向、流動性、滑價或尾部風險。
- 不把官網的示範畫面、模型 confidence 或內建模板當成績效證據。官方法律與安全頁也明確指出，回測與模擬結果不代表未來績效。
- 不直接切換到 QuantDinger 實盤、不匯入外部憑證，也不將其 MCP／Agent 寫入目前 Demo 的下單路徑。

## 建議的後續順序

1. 先完成跨現貨／合約共用 risk gate 與 experiment manifest，確保每筆交易都能回答「哪個版本、哪個資料窗、哪個成本假設、哪個風控結果」。
2. 對目前訂單流政策做 walk-forward 與成本壓力測試，按 pair、方向、持有時間、滑價和退出原因分 cohort；結果不足時保持 Demo，不用放寬門檻湊交易數。
3. 把拒單、資料過期、部分成交、unknown、保護安裝延遲做成 dashboard/告警；這能先排除執行問題，再判斷訊號本身是否有優勢。
4. 取得足夠的前瞻成交樣本後，再比較 order-flow、模型排序及簡單趨勢基準；只有成本後、樣本外、跨時段結果穩定，才考慮進入小額真實資金評估。

## 來源

- [QuantDinger 官方網站](https://www.quantdinger.com/)
- [QuantDinger 中文專案文件](https://www.quantdinger.com/doc/README_CN.html)
- [系統架構總覽](https://www.quantdinger.com/doc/architecture/README_CN.html)
- [Strategy API V2 策略開發指南](https://www.quantdinger.com/doc/trading/STRATEGY_DEV_GUIDE_CN.html)
- [可觀測性文件](https://www.quantdinger.com/doc/deployment/OBSERVABILITY_CN.html)
- [官方 GitHub](https://github.com/OpenByteInc/QuantDinger)
