# 鏈上資金背景與訂單流整合

目前執行補充為 [22:00 觀察器恢復與流程圖更新](capital-recovery-2026-09-15.md)，來源與驗證在 `local/capital-recovery-2026-09-15/validation.json`。以下為原始啟用說明；觀察起點、背景定義與非交易門檻邊界維持。

2026-09-15 台北 21:03 啟動 `capital-flow-observer-v1` 公開資料觀察版。部署證據：`local/chain-flow-2026-09-15/validation.json`。現行交易策略權威來源仍為 signed-strength 與 health-queue manifest；本次不改策略指紋、原生退出、停損、目標或任何成交歷史。

## 現在實際運作

- `src/capital-flow.mjs`：來源驗證、背景分類、前瞻交易歸因、真實淨損益分組。
- `src/capital-flow-store.mjs`：由本地 dashboard 程序持續收集，不依賴瀏覽器頁面開啟；只讀既有 Demo 訂單流檔案及專用引擎交易紀錄，無下單方法。重啟 dashboard 會恢復同一觀察起點與不可覆寫的交易歸因。
- 公開 DefiLlama `https://stablecoins.llama.fi/stablecoincharts/{chain}`，每 15 分鐘查詢 all / Ethereum / Solana / BSC / Near。官方 API 文檔的通用 api.llama.fi base 在實測 stablecoincharts 回 404；已以實際 stablecoins 子網域成功回應核對五組資料。
- 使用 `totalCirculating.peggedUSD` 名目流通供給，不合計日圓／歐元等不同幣別，不拿市場價格變動、未發行量或 global+chain 重複計數。完整一日／七日比較基準必須存在。
- 保留來源資料日期、收到資料時間、來源 URL、精確比較點及內容 hash。收到超過 30 分鐘、來源超過 48 小時、未來時間、數字錯誤均不可作有效背景。時間門檻是資料品質設定，並非調參所得的獲利門檻。
- 每五秒讀取既有 Demo 訂單流；以原有 assessOrderFlow 驗證，沒有新增市場請求或改交易取樣。現貨做多、合約多空都記錄。
- ETH/SOL/BNB/NEAR 用相應鏈背景；UNI/BTC 等僅用全市場背景，沒有把 Ethereum 生態供給當成 UNI 自身資金流。
- 一日及七日供給同增標記 expanding、同減 contracting；其餘 mixed/neutral。相對交易方向分同向、反向；+1/-1/0 是研究排序標記，非機率，也不影響下單。
- 交易歸因只使用開倉前已實際記錄且行情、觀察皆在 45 秒內的資料，來源在開倉時也須有效。新功能啟動前的交易不回填；空窗／遺失明列 unattributed。此資料是鄰近進場的背景觀察，並非交易引擎實際用它作決策的證明。
- 每 30 秒讀取現貨／合約完整歷史，把啟動後真正成交按原 trade_id 與 mode 配對。平倉採 profit_abs，包含引擎已記錄費用／資金費，不再重扣。浮動不併入分組已實現。提供勝率、平均淨損益、平均贏／輸、平倉序列回撤。缺失 PnL 不當零；單一帳戶失敗不顯示其舊統計。
- `/api/capital-flow` 與頁面 `#capital-flow` 同步呈現來源、參考排序、各組成效與逐筆明細；維持 loopback / GET-only / origin 檢查。

## 邊界與下一步

尚未取得有地址標記的交易所淨流入或巨鯨資料權限；這兩項明列未接通，不能宣稱全套鏈上流已接通。穩定幣供給是日級資金背景，不能冒充交易所即時買盤。未自動訂閱服務或取得付費 API。

觀察模式不新增交易門檻，也不更改候選選擇；鏈上缺失不會停止 Demo。比較組只是同一策略下的背景分類，包含資產／時間／策略狀態混雜，不能稱為因果 A/B 勝率提升。沒有自動轉為交易排序；待實際扣費結果與資料可用率足夠，再設計前瞻排序實驗。不能以測試通過或日級供給同向宣称穩定獲利。

資料：`local/capital-flow/state.json`、`sources/*.json`、按 UTC 日期分檔 `observations-*.jsonl`、`trades/{mode}-{id}.json`、`report.json`。保留資料，不清除舊虧損。停止 dashboard 程序只停止此觀察器；現有交易／模型程序不受影響。

測試：`node --test test/capital-flow.test.mjs test/today-pnl.test.mjs test/dashboard.test.mjs test/dashboard-integration.test.mjs`，23 項通過。另核對五個真實 API 回應、執行中頁面和新觀察檔；截至初次啟用未有新 cohort 成交，沒有獲利改善結論。

參考：
- https://github.com/DefiLlama/api-docs/blob/main/llms-free.txt
- https://stablecoins.llama.fi/stablecoincharts/all
- https://docs.glassnode.com/further-information/exchange-data-transparency-notice
