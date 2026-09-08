# 在另一台 Windows 開始

GitHub repository 只包含原始碼，不包含本機交易紀錄、金鑰、Python 環境或 node_modules。
不需要 Docker；也不需要啟動 OpenAlice。

## 1. 從 GitHub 取得專案

Repository：https://github.com/ipass003482/binancetrade
先以有權限的 GitHub 帳號登入 Git／GitHub CLI，再執行：

~~~powershell
git clone https://github.com/ipass003482/binancetrade.git "D:\Codex\Binance trade"
~~~

若換成其他位置，以下 Set-Location 改成實際路徑即可。
需要 Node.js 22+、Git，以及已安裝並登入的原生 Codex CLI。

## 2. 安裝專案依賴

在 PowerShell 執行：

~~~powershell
Set-Location -LiteralPath 'D:\Codex\Binance trade'
npm.cmd ci --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-native.ps1
node src/cli.mjs setup
node src/cli.mjs setup --mode demo
~~~

Python／uv 只安裝在本專案內。首次安裝需要網路。

## 3. 在本機填入幣安 Demo 金鑰

到幣安 Demo Trading 的 API 管理建立 Demo 專用 Key／Secret，然後：

~~~powershell
powershell.exe -NoProfile -File scripts/configure-demo.ps1
node src/cli.mjs demo-check --mode demo
~~~

金鑰在本機提示中輸入，請勿貼到聊天。這一步只查詢帳戶，不下單。
檢查結果應為 mode=demo、accountType=SPOT、canTrade=true。
請使用供本專案獨立管理的 Demo 環境。

## 4. 啟動與執行一輪

第一個 PowerShell：

~~~powershell
node src/cli.mjs engine --mode demo
~~~

另一個 PowerShell：

~~~powershell
Set-Location -LiteralPath 'D:\Codex\Binance trade'
node src/cli.mjs cycle --mode demo
node src/cli.mjs health --mode demo
node src/cli.mjs report --mode demo
~~~

cycle 可能回傳 HOLD，這是正常結果。報表命令會印出 Markdown／JSON 的位置。
要持續運作，明確執行 node src/cli.mjs watch --mode demo；
不會自動建立背景排程。

## 停止與後續驗證

暫停新開倉：node src/cli.mjs stop --mode demo。
它不會全部平倉；持倉退出仍需引擎和網路運作。

已在原電腦跑通：Codex 強制 HOLD、原生本機模擬買賣／空倉／報表、
Demo 公開行情、四個 Web3 查詢、DPAPI 假金鑰加密。
尚未驗證：你的 Demo 金鑰、簽名帳戶 API、Demo 實際模擬成交與費用。
依你的要求，不再追加原電腦測試；改在這台驗證。

需要明確做一筆 Demo 虛擬資金買賣時，可在引擎已啟動且帳戶無掛單、
本引擎無持倉時執行 npm.cmd run test:demo-account。
它沿用風控上限；失敗請先查 status／reconcile，不要直接重跑。

完整說明見 README.md；技術交接與驗證紀錄見 plans/demo-operations.md。
