# 原生成交對帳欄位相容性修復

2026-09-16 04:20 台北。SUI81 於03:40已在Demo成交，原生order_filled/custom_stoploss出現SQLAlchemy QueuePool timeout，主機等待12秒後失去RPC回應，意圖2c72a5c36d09e33b16bca75017b0de38保存unknown，03:50三次失敗停止進場。既有supervisor於03:41已恢復現貨引擎；本輪未重啟引擎或模型。連線池耗盡的具體根因仍未證實，不能把此次修復說成已修復SQL資源問題。

可重現對帳缺陷：/status原生持倉orders沒有ft_is_entry欄位，舊entryProof只選ft_is_entry===true，對真實完整成交仍回傳null。已改成僅在欄位完全不存在時使用方向判定候選，仍逐一核對trade/tag/pair、side、唯一order id、closed/remaining=0、數量步進、精確safe_price、成本與預算。明確false/null/undefined/錯誤型別不套用fallback，多重候選／跨交易重複order仍拒絕。不是憑查無紀錄清除意圖，也不將拒單改成成交。

6項測試通過，含現貨／合約方向、缺欄位、錯誤旗標、錯標籤、部分成交、重複訂單、錯金額及重跑只追加一次。真實SUI81核對order1065635601，成交74.7 SUI、毛額51.52806 USDT、步進0.1；依既有execution.lock追加reconciled，保留pending與unknown並且沒有重送。證據在local/v12-reconcile-2026-09-16/reconciliation-proof.json、history-before.json及tests.log。

修復檔src/reconcile.mjs不在原74份策略來源內，以source-deployment.json另存雜湊並納入例行operation-check，原策略指紋／門檻／風險／目標不變。cli resume後supervisor啟動現貨watch23528，新週期驗證在validation.json。此為對帳工具的永久欄位相容性修復；尚未實作每輪自動對帳或正常callback拒單的持久回執，不可宣稱已解決所有unknown／SQLtimeout。

同輪新平倉ETH61空單-1.48125012，超過計畫1USDT：引擎記錄停損2417.99，實際成交2434.74，0.047 ETH的差額為0.78725 USDT（未重扣費用）。屬实际停損成交價偏離的風險證據，不把1USDT預算說成虧損硬上限。需累積交換所原始停損／成交資料研究尾部滑價與成本預留，不能刪除此筆或以放寬停損掩蓋。SOL62空單淨利+0.56842192；兩筆均有實際交易所停損成交。

連線池後續線索（尚非根因證明）：本機Freqtrade的CustomData與Trade是不同scoped session，API get_rpc清理Trade，而force_entry沒有custom_data_rpc_wrapper；我們的order_filled會讀取custom data。需用拋棄式SQLite／request context重現其資源釋放，再考慮包裝清理，不能直接擴大pool掩蓋。來源行號保存pool-hypothesis.json。
