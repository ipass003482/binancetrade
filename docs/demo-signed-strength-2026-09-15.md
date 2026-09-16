# 現貨有號排名差值修復

2026-09-15 台灣時間。17:30 NEAR 原始計畫買盤變化 delta=-0.05042724446987871517，基礎 flow 可成立但買盤比第一筆略弱；依現行政策只應影響排序。原生 guard v10 把它交給預設拒絕負數的 decimal parser，造成 DEMO_NATIVE_MODEL_NUMBER_INVALID，callback 在 create_order 前返回拒絕。主機得到通用提交失敗，保留 unknown 並在第三次失敗時停止現貨 watch。合約和模型仍運行。

對帳證據在 local/v12-signed-strength-2026-09-15：原始計畫、精確 tag 的原生日誌、17:29–17:32 Demo NEAR allOrders 完整空窗、完整引擎歷史及無持倉。單一 intent cb13a6865aa2602944c935e3c349d2c2 已追加 rejected，未改原 journal、未重送、未算成交。rejection-proof.json 保存來源雜湊。不能把一般 API 錯誤或查無引擎成交自動當成未下單。

只對排名差值啟用 signed=True；其他金額、價格、成本仍遵守原非負／正數檢查。型別、有限數字、指數上限與原始五檔差值重算核對不變；負的偽造排名仍拒絕。沿用 v10／flow-strength-exit-v1 是修復既定契約，不是新的策略門檻。

新增測試證明負 delta 通過實際 native callback、context、wire 純測試流程；NaN、Infinity、極端數字、錯誤型別、偽造差值均拒絕，其他負價格／費用仍拒絕。原始 NEAR 歷史計畫在修復前產生相同錯誤，修復後通過靜態契約檢查，未重播交易。544 JS、596 Python 通過。

受控更新保留舊 plan、所有 goal、共同基期、損失和成交。新策略來源 manifest 是 running.json，共74份；health寫入排序仍另依 local/v12-health-queue-2026-09-15/source-deployment.json 核對。此次維護不停止或重啟模型。新週期與維護時間記錄 validation.json。

這次只修正不該擋單的程式错误，不代表改善勝率，亦不放寬55%、成本、ATR、風險和資料完整性。後续驗證真實現貨成交與持續反向退出；不能用測試通過宣稱賺錢。

模型觀察程序另於18:14:01回報MODEL_OPERATION_FAILED退出；既有watchdog於18:14:12證明程序不存在後自動恢復，18:15回到健康且pin不變。本次維護沒有下達模型停止／重啟，但實際程序曾自動恢復，故不能聲稱未中斷；validation保留 recovery archive與原日誌。具體退出根因尚未由這個通用錯誤證實。

18:15新週期驗證完成，現貨18:15:13、合約18:15:21完成，均HOLD。18:15:48實際今日目標現貨4/100、合約5/100，均已平倉；現貨-0.49769756、合約+1.16300452，合計+0.66530696USDT。SOL50本次新增平倉-0.47753904，樣本觀察未見正浮盈（首次0除外）；不因此直接更改策略門檻。
