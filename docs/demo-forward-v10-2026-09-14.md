# v10：以實際淨浮盈高點收緊原生停損

使用者再次指出策略仍虧錢，要求改進。上一輪修復復原與診斷，交易仍是 v9，沒有實作先前提出的退出改善；本輪在既有自主 Demo 授權下，實際修改新倉策略為 `atr15m-forward-v10`，原生引擎 `demo-rule-exits-v10`，prompt version 10。

## 為什麼還在虧錢

9/14 08:35:51 完整對帳：共同 2000 USDT 試驗累積 **-11.98755571**，已取樣最大回撤 14.71571657，空倉。v9 現貨 7 筆已平淨 +1.56823846，合約 6 筆 -2.72858430，合計 -1.16034584；現貨含跨停電 UNI 52 的 +4.37166290，不能把這筆當成正常四小時退出改善的證據。

04:54 檢查之後又新增三筆虧損：XRP 現貨 56 淨 -0.89782082，SOL 空單 33、34 各 -0.85440600、-0.66366312。精確成交輸入在 `local/readiness/2026-09-14T00-35-53-571Z-fa4acccc/`，SHA256 `f160b45f63321f2bd2ec7bad4a02faa3b78dfdbe5b3cee37305369a7fc27be8f`。

兩個問題要分開：一是行情在進場後走反、直接吃到原停損；二是已出現的浮盈沒有充分保留。NEAR 現貨 54 在原生回呼記錄淨浮盈 +0.58494240，含費保本啟動後實際只留下 +0.01221570。SOL 合約 29、30 也只留下約一美分。這是退出改善的實際依據，並不證明單靠移動停利就能修復所有進場虧損。完整保本與成交紀錄見 `local/check-0914-0453/new-trade-evidence.json`。

## 本輪策略假設與數值來源

新倉沿用 v9 的進場条件、5m 收盤評估、量能 0.8、方向、突破回測、初始 ATR 停損／目標、最長四小時及每筆含成本風險 1 USDT。只改退出中啟動獲利保護後的行為：

1. 使用 Freqtrade 依實際持倉數量、進出場費率及已累計資金費計算的淨浮盈。未達 0.50 USDT 時仍維持原停損。
2. 達到 0.50 USDT 時啟動 `net-profit-trail-v1`。記錄之後每次原生回呼觀測到的最高淨浮盈，以「高點 - 0.25 USDT」計算目標淨利保護線。
3. 將目標淨利反解成多／空的原生停損價格，依交易所 tick 往有利保護方向取整。以當時實際數量、費率及資金費重算，原停損與已存停損只收緊、不放寬。
4. 高點與保護價格保存在原生 SQLite 的 `net_profit_trail`；重新啟動與 after_fill 不重設高點。已跳過停損線時有 `rules_profit_trail` 的原生退出判斷，原生換單仍遵守既有有界撤單對帳和替換頻率。

**數值並非由歷史收益最佳化得來。** 0.50 沿用原版啟動門檻，也是 1 USDT 風險預算的一半；0.25 選為該預算四分之一、啟動門檻一半，作為這次可辨識的測試起點。它可能比固定保本更早退出，也可能失去後續延伸行情。觸發價格、停損限價未成交、行情跳空、替換延遲及滑價都可能讓實際收益低於目標線；不能說每筆回吐已保證最多 0.25。

概念參考 [Hummingbot 官方範例](https://hummingbot.org/strategies/v2-strategies/examples/) 的啟動門檻加移動距離設計，以及 [Freqtrade 原生 custom stoploss 文件](https://www.freqtrade.io/en/stable/strategy-callbacks/#custom-stoploss) 的方向、價格換算和 after_fill 語義。本專案用淨 USDT 而非直接抄其價格百分比；官方資料不支持宣稱 0.25 是最佳值，也不構成獲利證據。

## 相容性及驗證

v7/v8/v9 舊計畫仍使用原 `fee_breakeven`，不繼承 v10 新規則；歷史量能組歸因仍可識別。v10 進場拒絕錯誤或舊的獲利保護參數，新進場計畫、bridge、native capability、prompt contract、forward trial 均使用對應版本。壞掉的淨損益／高點／時間證據會保留既有原生停損並暫停新曝險，不捏造保護價格。

驗證完成：335 項 JS、237 項 Python、118 檔語法與設定檢查通過。Python 包含多／空、不同槓桿、幣本位費用後數量、正負資金費、精度與重複回呼不漂移、逐步收緊、回撤及跳空、損壞狀態、倒退時間、SQLite 真正關閉重開、舊版退出不變，以及 guarded adapter 的原生停損替換／方向／數量／回執。pytest 僅有既有快取目錄無寫入權限警告，測試通過。

原生 Freqtrade 隔離 dry-run 開／平倉契約 smoke 通過，`local/native-smoke/480b501c-693f-4277-a9a7-3ab4e6589b1e/`，不計入策略 Demo 成交。測試與驗證日志為 `local/v10-js.log`、`local/v10-python-final.log`、`local/v10-check.log`、`local/v10-native.log`。

## 部署、基期與後續判斷

08:36–08:37 左右透過 cli stop 暫停两模式新進場，精確 STOP 在 `local/v10-deploy-baseline/{mode}/STOP`。08:44:33 再對帳，現貨完整歷史 56 筆、合約 34 筆，均無持倉或未決送單。`local/v10-deploy-baseline/` 保存舊 v9 trial、report、history、journal、退出計畫雜湊、共同基期及兩邊 SQLite 一致性備份（integrity_check 均 ok）。修改前來源副本在 `local/v10-source-backup/`。兩個 v9 trial/report 另由版本移轉函式保留帶原版本名稱的封存。

停掉已核對身分的 supervisor、dashboard 與 native 引擎後，所有舊節點／Python 子程序及監聽埠均確認不存在才清理死亡鎖；沒有批次殺掉其他應用。停止時一個已驗證程序自行退出，後續重新盤點確認全部專案 worker 不存在後才繼續。新引擎在 08:46:55 啟動，08:47:11 API 與原生保護均驗證 `demo-rule-exits-v10`，未決為零。建立獨立 v10 forward trial，排除全部先前交易；共同 2000 USDT 原基期、虧損與舊退出計畫雜湊不變。

08:47 已 resume 兩模式，supervisor／dashboard／watcher 恢復。首個新五分鐘週期的完成核對見下方追加紀錄。每日進場次數保持不限；新版本不能補算舊 9/11 各 35 筆目標。後續以实际成交淨利、收益回吐、初始停損損失、退出原因與共同回撤比較 v9/v10，明示不同时段市场差異，不用歷史快照套值冒充新版本成交收益。

## 完成核對：08:52

現貨、合約分別在 08:50:13.114、08:50:12.186 完成第一個 v10 五分鐘週期，均 HOLD。snapshot／rules／analysis／prompt-contract、prompt version 10 與提示詞 SHA256 核對一致；策略參數精確符合淨浮盈 0.50 啟動、高點減 0.25，量能輪替關閉。實際載入的原生版本是 demo-rule-exits-v10，並非只改設定檔。部署來源聯集 54 檔已保存精確副本與 SHA256 至 `local/v10-deployed-source/`；首輪證據 `local/v10-first-cycles.json`。

08:50:39 兩邊空倉、未決送單 0、原生保護核對通過、STOP 不存在；v10 尚無成交。共同累積仍 -11.98755571，證據完整；舊退出計畫、既有 journal 前綴及共同基期固定欄位／舊歸因均不變，保存在 `local/v10-deploy-baseline/running.json`。這是部署成功，尚未有 v10 獲利結果。

實際暫停開始為 08:36:46，08:47 恢復，缺失 08:40／08:45 每模式兩個評估窗口，不補造交易。引擎 owner 現貨 15472／合約 23476，原生 Python 18184／16272；watcher 22700／5432，supervisor 16060、dashboard 25160。08:51:54 supervisor 回報兩邊 RUNNING；dashboard API 兩邊 healthy=true、rulesReady=true、daily entries unlimited=true，校時無錯誤。

既有同一 `binance-demo` 監督提示詞已更新至 v10，要求讀 net_profit_trail 高點／保護線與實際回執，仍分開檢查未達觸發的虧損和觸發後回吐。回讀 automation.toml 確認完整提示詞一致，id、名稱、目標任務、ACTIVE／每 6 小時及建立時間保留。下一輪不會依舊 v9 指令回退，沒有新建重複排程。
