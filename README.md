# Binance trade

獨立的 Windows 原生 Binance 現貨研究與模擬交易專案。
Codex CLI 負責分析；程式風控決定能否送單；Freqtrade 管理訂單、持倉與退出。
不使用 Docker，不連接 OpenAlice／UTA，不支援真實資金交易。

## 兩種模式

| | 本機模擬（預設） | 幣安 Demo |
|---|---|---|
| 指令 | 不加模式參數 | 加上 `--mode demo` |
| 成交位置 | Freqtrade 本機模擬 | 幣安 Demo 的虛擬資金帳戶 |
| 行情 | Binance 公開現貨 | Binance Demo 現貨 |
| 金鑰 | 不需要 | Demo 專用 Key／Secret |
| 本機 API | 127.0.0.1:18080 | 127.0.0.1:18082 |
| 資料目錄 | local/ | local/demo/ |

每個模式的認證、資料庫、訂單紀錄、停止標記和報表都分開。
本機模擬與 Demo 都不是策略獲利證明。Demo 也不是 Spot Testnet。

## 本機模擬快速開始

這台電腦的依賴已安裝。在第一個 PowerShell：

~~~powershell
Set-Location -LiteralPath 'D:\Codex\Binance trade'
node src/cli.mjs doctor
node src/cli.mjs engine
~~~

保持引擎終端開啟，在另一個 PowerShell：

~~~powershell
Set-Location -LiteralPath 'D:\Codex\Binance trade'
node src/cli.mjs cycle
node src/cli.mjs report
~~~

cycle 執行一輪研究、Codex 分析與風控；HOLD／觀望是正常結果。
Codex 使用本機既有登入。若需要登入，請在自己的終端執行 codex login。

## 接幣安 Demo 現貨

1. 在幣安 Demo Trading 的 API 管理建立 **Demo 專用** Key／Secret。
2. 執行以下指令，在本機提示中輸入金鑰；不要貼到聊天。
3. 先跑唯讀帳戶檢查，確認連線與權限，再啟動 Demo 引擎。

~~~powershell
Set-Location -LiteralPath 'D:\Codex\Binance trade'
node src/cli.mjs setup --mode demo
powershell.exe -NoProfile -File scripts/configure-demo.ps1
node src/cli.mjs demo-check --mode demo
node src/cli.mjs engine --mode demo
~~~

另一個終端：

~~~powershell
Set-Location -LiteralPath 'D:\Codex\Binance trade'
node src/cli.mjs cycle --mode demo
node src/cli.mjs health --mode demo
node src/cli.mjs report --mode demo
~~~

金鑰以 Windows DPAPI 加密，只有相同 Windows 使用者可以正常解密；
換電腦要重新輸入。研究用 Codex 不會收到這些金鑰。
使用獨立供本專案使用的 Demo 帳戶／環境；同帳戶的不同 Key 不會隔離資金。
不要同時在該帳戶手動交易或交給另一個機器人管理。

**實作方式：** Freqtrade 2026.8 原本停用 Binance Demo。本專案使用程序內的
Demo 適配層，保留 Freqtrade 的訂單與退出管理，未修改安裝套件。
同步與非同步交易連線都限制到 https://demo-api.binance.com/api/，拒絕轉址，
關閉不適用的 WebSocket、期貨與錢包服務。詳見 [運作契約](docs/operations.md)。

Freqtrade 內部用 `dry_run: false`／`runmode: live` 表示要送到交易所；
本專案的 Demo 還必須有 `demo_trading: true`、專用引擎身份和 Demo 網址保護。
不能只手動更改 dry_run 來切換模式。

## Demo 帳戶買賣驗收

填好 Demo 金鑰、完成唯讀檢查並啟動 Demo 引擎後，可明確執行：

~~~powershell
npm.cmd run test:demo-account
~~~

此命令會使用虛擬資金做一筆 BTC/USDT 買入與賣出。開始前要求沒有掛單、
沒有本引擎持倉，且不處於停止狀態；保留原有風控上限。最後核對引擎持倉、
交易所掛單和 BTC 餘額差額，結果存入 local/demo/acceptance/。

失敗不會盲目重試或清掉原有帳戶資產。先看 status／reconcile 與驗收紀錄；
引擎會保持運行以管理已存在的持倉。尚未提供 Demo 金鑰時，
簽名 API、Demo 成交與費用核對仍屬待驗收項目。

## 持續運行、監控、停止

~~~powershell
node src/cli.mjs watch --mode demo
node src/cli.mjs health --mode demo
node src/cli.mjs stop --mode demo
~~~

watch 在前景每輪完成後等待 900 秒；持續寫入心跳和執行結果。
同一模式只允許一個 watch、一輪 cycle 和一個引擎啟動器。
連續三輪失敗會寫入 STOP 並停止新開倉。錯誤代碼、最後成功時間與階段
可用 health 查看。沒有建立開機啟動、Windows 服務或背景排程。

stop 是「暫停新開倉」，不是全部平倉。既有止損與 ROI 退出需要
Freqtrade、網路與電腦保持運作。按 Ctrl+C 可停止研究迴圈；
引擎本身請先檢查持倉後再停止。已送出的請求不能靠 STOP 撤回。

修復問題後：

~~~powershell
node src/cli.mjs reconcile --mode demo
node src/cli.mjs resume --mode demo
node src/cli.mjs watch --mode demo
~~~

resume 要求引擎身份正確且沒有未知送單；不會自行啟動研究。

## 異常中斷與鎖檔復原

~~~powershell
node src/cli.mjs health --mode demo
node src/cli.mjs recover-lock cycle --mode demo
~~~

可指定 engine、watch、cycle、execution、health 或 events。
只有確認記錄的程序及子程序已結束，且沒有其他可辨識的專案程序時才移除。
無法確認、PID 被重用或另有專案程序時會拒絕；不會按時間強搶鎖。
Windows 程序查詢權限不足時也會停止恢復。

recover-lock 不修改訂單紀錄，也不代表某筆訂單未送出。
未知訂單必须透過 reconcile 取得明確證據；找不到時繼續阻擋送單。

## 研究資料

config/research.json 管理每個商品的鏈上代幣映射與公開觀察錢包。
目前 BTC/USDT、ETH/USDT 的自動研究包含：

- 已收盤 15 分鐘 K 線、SMA8／20、1 小時／4 小時報酬、ATR14、相對成交量。
- Binance Web3 排名背景及代幣搜尋候選；候選明確標成未驗證。
- 當有明確合約映射時，加入代幣基本資訊、動態資料與安全查詢。
- 當有設定觀察錢包時，加入公開持倉查詢，標示只有第一頁。

BTC／ETH 未設定合約映射；不把同名包裝代幣自動當成原生幣。
每個映射必須包含 chainId、contractAddress、relationship、source、note；
relationship 可為 token 或 wrapped-proxy。钱包需 chainId、address、label。
缺少映射或查詢失敗會明確記錄，安全查詢無結果不等於低風險。

四個固定版本技能仍可個別呼叫，使用 `node src/cli.mjs help` 查看介面。
部分上游 K 線查詢使用 dquery.sintral.io，會保留来源資訊。
尚未提供歷史 Web3 訊號的回測或經績效驗證的交易策略。

## 決策與績效報表

report 產出 Markdown 與 JSON，印出可開啟的路徑，內容包括：

- 每輪提案、理由、證據 ID、送單狀態，以及相對應的交易／訂單。
- 已平倉淨損益、勝率、已平倉損益的回撤，以及目前持倉。
- 費用按幣別分列，缺少欄位明確顯示；不重複從淨損益扣費。
- 最近失敗／中斷原因，區分沒送出、已送出與實際成交。

引擎無法連線時，可用上次快取產生報表，但會標示過期。
過期報表不能用來確認目前持倉；回撤也不是完整帳戶權益回撤。
研究和訂單紀錄保留在本機，events 診斷日誌限制為兩份各約 2 MB。
快照、成交資料與報表沒有自動刪除，長期使用需留意磁碟空間。

## 預設限制（虛擬資金）

| 項目 | 預設 |
|---|---|
| 商品 | BTC/USDT、ETH/USDT |
| 單筆／總投入上限 | 25／50 USDT |
| 同時持倉 | 2 |
| 每 UTC 日開倉嘗試上限 | 4 |
| 每日損失開倉門檻 | 已實現當日損益＋目前未實現損益 ≤ -20 USDT |
| 訊號有效期／送單前報價有效期 | 600／15 秒 |
| 最大價差／價格偏移 | 20／100 bps |
| 策略止損 | -2%，不保證成交價 |
| ROI 退出 | 初始 3%，120 分鐘後 1.5%，360 分鐘後 0.5% |

本機模擬起始餘額為 1,000 USDT；Demo 使用幣安 Demo 帳戶的虛擬餘額。
變更 config/policy.json 後，需同步調整各模式引擎設定，啟動器會檢查一致性；
setup 不覆寫既有設定。

## 安裝與驗證

另一台 Windows 需要 Node.js 22+、Git 和原生 Codex CLI：

~~~powershell
npm.cmd ci --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-native.ps1
node src/cli.mjs setup
~~~

Python／uv／venv 在專案內，不改系統 PATH。不要複製 local/ 的認證或交易狀態。

~~~powershell
npm.cmd run check
npm.cmd test
npm.cmd run test:python
npm.cmd run test:credentials
npm.cmd run test:research
npm.cmd run test:demo-public
npm.cmd run test:native
~~~

test:native 使用 18081 與獨立本機模擬資料庫；不是 Demo 帳戶測試。
test:demo-public 不需要金鑰、不下單；test:demo-account 才會送出虛擬資金訂單。
驗證狀態與仍待驗收項目見 [執行計畫](plans/demo-operations.md)。

上游研究技能固定來源記錄在 sources/binance-skills.json。
部分授權資訊尚不完整；上游下載的技能內容不納入本 repository，
由 setup 在本機取得。Repository：https://github.com/ipass003482/binancetrade。
另一台電腦的 clone 與啟動步驟見 [START-HERE.md](START-HERE.md)。
