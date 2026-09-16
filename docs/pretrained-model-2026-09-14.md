# Kronos 預訓練模型串接與前向驗證

後續狀態：使用者已要求模型參與下單，進場整合見 [v11 模型 DEMO](demo-model-v11-2026-09-14.md)。下文為最初僅觀察階段的部署紀錄，不能當成後續下單權限或即時狀態。

2026-09-14，Asia/Taipei。使用者要求參考現成模型，因應 alpha 衰退，最後以約 2,000 USDT 的真實資金取得持續扣費獲利；當前執行授權仍限 Binance Demo。

## 已完成與目前角色

已下載並核對官方 **NeoQuasar/Kronos-small** 與 tokenizer 固定權重，在獨立 `.venv-model` 本機 CPU 載入並啟動持續推論。沒有重新訓練或微調。每次機器人產生五分鐘已收盤快照時，讀取 96 根 K 線，預測接下來三根 K；每五分鐘更新，並非十五分鐘才檢查一次。

這是已運行的模型資料串接與即時觀察。`executionRole=advisory`、`usedForOrders=false`、`modelOrders=0`；實際下單仍由 `atr15m-forward-v10` 規則引擎執行。模型沒有訂單工具，也不讀取帳戶金鑰。不能稱模型已在交易、已獲利或已克服 alpha 衰退。

## 選擇依據

公開訊號被廣泛使用後，收益可能下降；McLean / Pontiff 研究的是股票報酬預測因子，不能直接推論所有加密貨幣模型都失效，更不能推論私有參數必然獲利。[原始論文](https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12365)

Kronos 專為金融 K 線預訓練，可同時讀取 OHLC、成交量與成交額，small 約 24.7M 參數、MIT 授權，符合現有 K 線輸入及本機算力。這是選它作第一個候選的工程判斷，官方範例不代表本專案五分鐘扣費策略的獲利證據。[官方模型卡](https://huggingface.co/NeoQuasar/Kronos-small)、[官方程式](https://github.com/shiyu-coder/Kronos)

| 候選 | 適配判斷 | 本次處理 |
|---|---|---|
| Kronos-small | 金融 K 線與成交量／額；本機實測能跟上五分鐘 | 已下載、載入、持續預測 |
| Chronos-2 | 通用多變量時間序列模型，可作後續獨立比較 | 未安裝、未宣稱本地成績 |
| TimesFM | 通用時間序列預測；版本與授權需逐一確認 | 未安裝 |

比較來源：[Chronos-2 官方模型卡](https://huggingface.co/amazon/chronos-2)、[TimesFM 官方版本與授權](https://github.com/google-research/timesfm)。使用者提到的 TypeBB 作為方向參考；查到的 OpenTypeBB 本身是市場資料相容層，不是預訓練交易模型。[固定版本 package.json](https://raw.githubusercontent.com/TraderAlice/OpenAlice/c02a3c7d7d438783897e3f7610714b121c41367c/packages/opentypebb/package.json)

## 實際前向紀錄

09:20 首輪：現貨 10 個、合約 4 個商品完成推論；純推論耗時約 3.52 秒及 1.25 秒。09:26 啟動持續程序。09:30 新輪次完成：現貨預測寫入 09:30:18.960，合約 09:30:20.614；目標收盤時間為 09:44:59.999（以上為台北時間）。當輪全部成本篩選建議 HOLD，並無模型訂單。不同實作指紋分開保留，不合併評分。

此紀錄來自 `local/model-research/predictions`、`loaded-model.json` 與 `status.json`。當輪未來收盤尚未發生，沒有已完成評分窗口。最新動態報告在 `local/model-research/report.md`，不能將這份部署紀錄當成稍後即時狀態。

09:40 更新後首輪：現貨 10/10 於 09:40:19.318 完成，合約 1/4（ETH）於 09:40:20.034 完成；BTC、BNB、SOL 的補讀資料與機器人原快照不一致，被 `MODEL_PROVIDER_CANDLE_REVISED` 拒絕。抽查 BTC 確認最後一根已收 K 的成交量兩次讀取不同，紀錄見 `local/model-research/provider-revision-check-20260914-btc.json`。保留原預測及錯誤，不放寬精確比對或事後補寫；部分輸出不是全商品成功，其不完整窗口不能列入完整模式評分。部署核對見 `local/model-research/deployment-20260914-final.json`。

帳務對照：`local/readiness/2026-09-14T01-24-53-402Z-172c6752/review.json` 所屬審查截至 09:24:52，共同 2,000 USDT 實驗累積淨損益 -11.98755571 USDT，兩模式無持倉，v10 尚無實際成交。這是整個 Demo 實驗的既有結果，並非新模型收益。

## 資料、成本與退化監控

- 僅使用當輪 96 根連續已收盤 K，核對交易所時鐘區間、來源、商品與快照雜湊；推論必須在已核對的 60 秒窗口完成。逾時即拒絕，不補寫歷史預測。
- 透過固定 Binance Demo 公開 GET 補讀真實 quote-asset volume；OHLCV 必須與原快照完全一致，不用價格乘成交量假造成交額。
- 取四條採樣路徑的平均預測，並非校準勝率或信賴區間。`temperature=1`、`topP=0.9` 參照官方例子；96 根沿用原快照，四次採樣為算力折衷，均非已找出的最佳獲利參數。
- 預測價格變動扣除原快照估計成本後，還須符合原有成本緩衝才產生做多／做空建議；現貨只做多。這是成本篩選，沒有模擬成交價或實現損益。
- 預測先寫入不可覆蓋檔案，等三根未來 K 真正收完，再記錄對照價格；保留精確輸入、模型版本、程式副本與每次預測 SHA256。
- 每十五分鐘取不重疊窗口，同批商品等權合併，分別比較現貨／合約模型誤差與「價格保持不變」基準。至少 30 個窗口作初步診斷，最近最多 100 個；30 並非每日交易額度或統計顯著證明。
- 最近 30 個窗口持續劣於基準時停用模型進場建議；只有前 30 個窗口較好而後 30 個轉差，才標記可能退化。從一開始就差只稱表現不足；`alphaEstablished=false`。此處不停止或改變 v10 的既有訂單管理。

模型尚未參與成交，預測誤差較小也不能直接證明扣費後 alpha。後續有足夠前向訊號再設計獨立模型 Demo 版本，以實際成交、費用、滑價及回撤檢驗，不將預測收益算進帳本，也不根據幾筆結果自動改權重。

既有成交的進場前特徵／成本與真正結果已補上可追溯資料匯出，報告為 `local/readiness/learning.md`。截至本次審查可精確配對 13 筆 v9 成交；它未用來訓練本次 Kronos，停電影響單仍留總帳並另標示。

## 操作與復原

```powershell
# 已完成環境與權重安裝；此命令只驗證來源並載入模型
.\.venv-model\Scripts\python.exe scripts/kronos-worker.py check
# 持續觀察：啟動器會核對既有程序，使用 OS 鎖避免重複 worker
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-model-worker.ps1
```

`.venv-model` 與主交易環境分開，依賴鎖在 `requirements.model.lock`。早期候選評估留下 LightGBM 安裝項，但本方案沒有訓練或使用它。正式模型權重約 99 MB、tokenizer 約 16 MB；由 `scripts/setup_kronos.py` 固定版本下載並驗證 SHA256，模型使用 safetensors 嚴格載入。沒有付費模型 API。

來源 commit：`67b630e67f6a18c9e9be918d9b4337c960db1e9a`。09:30 使用指紋：`d80935eb4a60dc6d1f969816815e640bdfcecb10ec8f5f168d8d2e3651f7cd93`。09:37:51 載入資料過期監控修正，指紋為 `dd1aa6e906b408af34bd95d09d0fec6c2250c620e31ebaee226d249a2995be53`；既有預測完整保留。全部權重、配置及來源雜湊詳見 `local/model-research/loaded-model.json`，相同指紋的程式副本在 `implementations`。

建立 `local/model-research/STOP` 可停止模型觀察，啟動器會尊重它；此檔不控制 v10。Windows 程序鎖防重複，模型在新資料到達前遇到 stale 狀態可能正常，須配合快照時間判讀。既有六小時審查負責檢查／必要時復原模型程序，不代表關機期間仍能推論，也不是 Windows 開機服務。

獨立覆核另修正「已記錄預測持續回報正常，掩蓋行情停更」的問題：正常等待顯示 `awaiting_next_cycle`，來源超過兩個五分鐘週期顯示 `stale_source`，時鐘或來源無效顯示 `unavailable`；狀態與報告提供來源邊界、年齡上下界及最後評分時間。沿用舊時鐘推算的年齡僅作資料健康診斷，不能授權逾時推論。程序等待下一輪亦不表示上一輪全部商品成功；需讀 `latest-demo.json`／`latest-demo-futures.json` 的 `errors`、`expectedPairs` 與實際 `forecasts` 數量。

## 驗證

最終 350 項 JavaScript、315 項 Python（其中 78 項模型資料／評分／停更契約）通過；120 個語法／設定檔檢查及隔離 Freqtrade 原生乾跑開平倉 smoke 通過。日誌：`local/kronos-final-js-serial.log`、`local/kronos-final-python.log`、`local/kronos-final-native-pass.log`。模型環境 `pip check` 通過，且已完成上列實際即時模型推論。這些驗證證明串接與契約運作，不是策略盈利證明。

驗證指令需沿用 package.json 的測試範圍與原生乾跑旗標。一次裸 `node --test` 誤掃入 local 的舊版本封存而失敗，已按專案原定 `--test-concurrency=1 test/*.test.mjs` 完整重跑通過；原生 smoke 首次漏傳 `--allow-dry-run-orders` 被正常拒絕，補正後通過。兩次失敗日誌保留，沒有改測試或放寬交易限制。
