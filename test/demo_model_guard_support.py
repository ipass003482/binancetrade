"""Offline synthetic inputs shared by native entry contract tests."""
import hashlib
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import demo_model_guard as guard

NOW = datetime(2026, 9, 14, 0, 0, 20, tzinfo=timezone.utc)
MS = int(NOW.timestamp() * 1000)
BOUNDARY = MS - 20000
SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111'
TAG = 'codex-' + hashlib.sha256(SNAPSHOT_ID.encode()).hexdigest()[:32]


def isolate(monkeypatch, tmp_path):
    monkeypatch.setattr(guard, 'ROOT', tmp_path)
    clock = {'wall': MS, 'mono': 100000.0}
    monkeypatch.setattr(guard, 'wall_ms', lambda: clock['wall'])
    monkeypatch.setattr(guard, 'monotonic_ms', lambda: clock['mono'])
    guard.clear_entry_permit()
    return clock


def add_guard(plan, rate=100, required=50, leverage=1):
    mode = 'demo-futures' if ':' in plan['pair'] else 'demo'
    plan['riskPolicy'] = dict(version='native-stop-risk-v1', mode=mode,
        stopLimitRatio='0.995' if mode == 'demo' else None,
        reserveFraction='0.005' if mode == 'demo' else '0')
    short = plan['isShort']
    target = str(rate * (.97 if short else 1.03))
    closes = [target] * 3
    atr15 = rate * plan['targetFraction'] / 2
    issued = datetime.fromtimestamp((BOUNDARY + 10000) / 1000, timezone.utc).isoformat()
    model = dict(modelFingerprint='b' * 64, predictionSha256='c' * 64,
                 snapshotId=SNAPSHOT_ID, issuedAt=issued, usedForEntryDecision=True)
    confirmation = dict(version='kronos-direction-atr-v1', confirmationAt=BOUNDARY,
        modelFingerprint=model['modelFingerprint'], predictionSha256=model['predictionSha256'], issuedAt=issued,
        targetCloseAt=BOUNDARY + 900000 - 1, forecastClose=target, quotePrice=str(rate),
        forecastCloses=closes.copy(), originClose=str(rate), atr15=atr15, targetAtr=2,
        targetFraction=plan['targetFraction'])
    confirmation['priceConfirmation'] = dict(version='closed-price-momentum-v1', confirmationAt=BOUNDARY,
        closeTimes=[BOUNDARY-(3-i)*300000-1 for i in range(4)],
        closes=[str(rate*(1.001 if short else .999))]*3+[str(rate)], eligible=True)
    plan['entryPolicyVersion'] = 'forecast-net-edge-v1'
    plan.update(tag=TAG, snapshotId=SNAPSHOT_ID, purpose='strategy', model=model, entryConfirmation=confirmation,
        nativeEntryGuard=dict(version=guard.LEGACY_VERSION, snapshotId=SNAPSHOT_ID, mode=mode, pair=plan['pair'],
        side='short' if short else 'long', modelFingerprint=model['modelFingerprint'], predictionSha256=model['predictionSha256'],
        candleBoundary=BOUNDARY, modelDeadline=BOUNDARY + 60000, issuedAt=issued, requiredPriceSpaceBps=str(required),
        forecastClose=target, forecastCloses=closes.copy(), originClose=str(rate), atr15=atr15, targetAtr=2,
        targetFraction=plan['targetFraction'], bridgeQuotePrice=str(rate), quoteFetchedAt=NOW.isoformat(), maxPriceMoveBps='50', leverage=leverage,
        clock=dict(mode=mode, source=('https://demo-fapi.binance.com/fapi/v1/time' if short or mode == 'demo-futures'
                                     else 'https://demo-api.binance.com/api/v3/time'),
                   requestStartedAt=MS - 10, receivedAt=MS, serverTime=MS)))
    return plan


def fake_exchange(mode='demo'):
    return SimpleNamespace(_protection_mode=mode, _amount_to_contracts=lambda pair, amount: amount,
                           amount_to_precision=lambda pair, amount: int(amount * 1000) / 1000)
