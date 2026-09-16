"""Offline exact negative receipts, without inferring an order result from HTTP."""
import copy
import importlib
import json
import os
import subprocess
from datetime import datetime, timezone
from hashlib import sha256
from types import SimpleNamespace

import ccxt
import pytest
from demo_model_guard_support import guard, isolate, fake_exchange
from test_demo_model_guard import advance
from test_demo_minute_adaptive import minute_plan, kwargs, wire, NODE, ROOT

rules = importlib.import_module('RuleExits')


@pytest.fixture
def setup(tmp_path, monkeypatch):
    clock = isolate(monkeypatch, tmp_path)
    monkeypatch.setattr(rules, 'ROOT', tmp_path)
    advance(clock, 120000)
    return clock


def callback_fixture(clock, short=False):
    plan = minute_plan(short)
    mode = 'demo-futures' if short else 'demo'
    path = guard.ROOT / 'local' / mode / 'entry-plans' / (plan['tag'] + '.json')
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = ('  ' + json.dumps(plan, indent=2) + '\n').encode()
    path.write_bytes(raw)
    exchange = fake_exchange(mode)
    strategy = rules.RuleExits()
    strategy.config = dict(trading_mode='futures' if short else 'spot', dry_run=False)
    strategy.dp = SimpleNamespace(_exchange=exchange)
    args = dict(pair=plan['pair'], order_type='market', amount=.25, rate=100,
        time_in_force='GTC', current_time=datetime.fromtimestamp(clock['wall']/1000, timezone.utc),
        entry_tag=plan['tag'], side='short' if short else 'long')
    receipt = path.parent.parent / 'entry-rejections' / path.name
    return plan, path, raw, exchange, strategy, args, receipt


@pytest.mark.parametrize('short', [False, True])
def test_callback_rejection_receipt_binds_exact_raw_plan_and_engine(setup, short):
    plan, path, raw, exchange, strategy, args, receipt = callback_fixture(setup, short)
    if short:
        advance(setup, 39995)
        expected = 'DEMO_NATIVE_MODEL_DEADLINE'
    else:
        args['rate'] = float(plan['entryConfirmation']['executionContinuation']['originAsk'])
        expected = 'DEMO_NATIVE_MODEL_FLOW_PRICE_NOT_CONTINUED'
    assert strategy.entry_risk_allowed(**args) is False
    assert guard._pending.get() is None and guard._active.get() is None
    assert json.loads(receipt.read_text()) == dict(schemaVersion=1, phase='callback_before_order',
        tag=plan['tag'], snapshotId=plan['snapshotId'], pair=plan['pair'],
        mode='demo-futures' if short else 'demo', decisionBoundary=plan['decisionBoundary'],
        nativeEntryGuardVersion=guard.VERSION, planCreatedAt=plan['createdAt'],
        planSha256=sha256(raw).hexdigest(), reason=expected, processId=os.getpid(),
        rejectedAt=datetime.fromtimestamp(setup['wall']/1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))
    assert list(receipt.parent.glob('*.tmp')) == []
    with pytest.raises(ccxt.PermissionDenied, match='PERMIT_REQUIRED'):
        with guard.order_context(exchange, **kwargs(plan)):
            pytest.fail('Rejected callback received an order permit')


@pytest.mark.parametrize('fault', ['missing', 'changed'])
def test_changed_or_missing_disk_plan_cannot_certify_callback_rejection(setup, fault):
    plan, path, raw, exchange, strategy, args, receipt = callback_fixture(setup)
    strategy._entry_plan = lambda *args: copy.deepcopy(plan)
    args['rate'] = float(plan['entryConfirmation']['executionContinuation']['originAsk'])
    if fault == 'missing':
        path.unlink()
    else:
        changed = copy.deepcopy(plan)
        changed['maxEntryNotionalUsdt'] += 1
        path.write_text(json.dumps(changed))
    assert strategy.entry_risk_allowed(**args) is False
    assert not receipt.exists()


def test_receipt_write_failure_preserves_rejection_and_leaves_no_partial_receipt(setup, monkeypatch):
    plan, path, raw, exchange, strategy, args, receipt = callback_fixture(setup)
    args['rate'] = float(plan['entryConfirmation']['executionContinuation']['originAsk'])
    def fail_replace(*args):
        raise OSError('isolated atomic replace failure')
    monkeypatch.setattr(guard.os, 'replace', fail_replace)
    assert strategy.entry_risk_allowed(**args) is False
    assert not receipt.exists() and list(receipt.parent.glob('*.tmp')) == []
    assert guard._pending.get() is None


@pytest.mark.parametrize('amount', [2, float('nan')])
def test_callback_pre_authorize_risk_rejection_has_exact_negative_receipt(setup, amount):
    plan, path, raw, exchange, strategy, args, receipt = callback_fixture(setup)
    args['amount'] = amount
    assert strategy.entry_risk_allowed(**args) is False
    result = json.loads(receipt.read_text())
    assert result['reason'] == 'DEMO_NATIVE_MODEL_CALLBACK_RISK_REJECTED'
    assert result['planSha256'] == sha256(raw).hexdigest()
    assert guard._pending.get() is None


@pytest.mark.parametrize('wire_failure', [False, True])
def test_successful_callback_or_later_wire_failure_never_creates_negative_callback_receipt(setup, wire_failure):
    plan, path, raw, exchange, strategy, args, receipt = callback_fixture(setup)
    assert strategy.entry_risk_allowed(**args)
    assert not guard.record_callback_rejection(plan, 'demo', plan['pair'], plan['tag'], 'ENTRY_CALLBACK_REJECTED')
    assert not receipt.exists()
    with guard.order_context(exchange, **kwargs(plan)):
        assert not guard.record_callback_rejection(plan, 'demo', plan['pair'], plan['tag'], 'ENTRY_CALLBACK_REJECTED')
        if wire_failure:
            advance(setup, 39995)
            with pytest.raises(ccxt.PermissionDenied):
                wire(exchange, plan)
        else:
            wire(exchange, plan)
    assert not receipt.exists()


@pytest.mark.parametrize('fault', ['tag', 'pair', 'mode', 'native_version', 'reason'])
def test_receipt_rejects_identity_mismatch_and_noncanonical_location(setup, fault):
    plan, path, raw, exchange, strategy, args, receipt = callback_fixture(setup)
    mode, pair, tag, reason = 'demo', plan['pair'], plan['tag'], 'ENTRY_CALLBACK_REJECTED'
    if fault == 'tag': tag = '../escape'
    elif fault == 'pair': pair = 'OTHER/USDT'
    elif fault == 'mode': mode = '../other'
    elif fault == 'native_version': plan['nativeEntryGuard']['version'] = 'unknown'
    else: reason = 'private raw error content'
    assert not guard.record_callback_rejection(plan, mode, pair, tag, reason)
    assert not receipt.exists()


def test_host_reads_native_receipt_only_for_exact_javascript_plan_bytes_and_attempt(setup):
    if not NODE.is_file():
        pytest.skip('Bundled Node runtime unavailable')
    plan, path, raw, exchange, strategy, args, receipt = callback_fixture(setup)
    source = "let s='';for await(const x of process.stdin)s+=x;process.stdout.write(JSON.stringify(JSON.parse(s),null,2)+'\\n');"
    formatted = subprocess.run([str(NODE), '--input-type=module', '-e', source], input=json.dumps(plan),
        cwd=ROOT, capture_output=True, text=True, timeout=15, check=True).stdout.encode()
    path.write_bytes(formatted)
    args['rate'] = float(plan['entryConfirmation']['executionContinuation']['originAsk'])
    assert strategy.entry_risk_allowed(**args) is False
    source = """import {entryPlanDigest,readEntryRejection} from './src/entry-rejection.mjs';
let s='';for await(const x of process.stdin)s+=x;const v=JSON.parse(s);
v.attempt.planSha256=entryPlanDigest(v.plan);
const accepted=await readEntryRejection(v);
const stale=await readEntryRejection({...v,attempt:{...v.attempt,startedAt:v.now+1}});
const wrongPid=await readEntryRejection({...v,attempt:{...v.attempt,processId:v.attempt.processId+1}});
process.stdout.write(JSON.stringify({accepted,stale,wrongPid}));"""
    values = dict(local=str(path.parent.parent), plan=plan,
        attempt=dict(mode='demo', processId=os.getpid(), startedAt=setup['wall']), now=setup['wall'])
    result = subprocess.run([str(NODE), '--input-type=module', '-e', source], input=json.dumps(values),
        cwd=ROOT, capture_output=True, text=True, timeout=15, check=True)
    output = json.loads(result.stdout)
    assert output['accepted']['planSha256'] == sha256(formatted).hexdigest()
    assert output['accepted']['reason'] == 'DEMO_NATIVE_MODEL_FLOW_PRICE_NOT_CONTINUED'
    assert output['stale'] is None and output['wrongPid'] is None
