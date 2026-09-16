import asyncio
import importlib.util
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import TimeoutError
from sqlalchemy.orm import scoped_session, sessionmaker
from freqtrade.persistence import Trade
from freqtrade.persistence.base import ModelBase
from freqtrade.persistence.custom_data import _CustomData, CustomDataWrapper
from freqtrade.persistence.models import get_request_or_thread_id, _request_id_ctx_var
from freqtrade.rpc.api_server import deps
from freqtrade.rpc.rpc import RPC, RPCException

spec = importlib.util.spec_from_file_location(
    'demo_rpc_sessions', Path(__file__).resolve().parents[1] / 'scripts/demo_rpc_sessions.py')
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


@pytest.fixture
def database(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + (tmp_path / 'fixture.sqlite').as_posix(),
                           pool_size=2, max_overflow=0, pool_timeout=.05)
    ModelBase.metadata.create_all(engine)
    for cls in (Trade, _CustomData):
        monkeypatch.setattr(cls, 'session', scoped_session(
            sessionmaker(bind=engine), scopefunc=get_request_or_thread_id), raising=False)
    yield engine
    for cls in (Trade, _CustomData):
        for session in list(cls.session.registry.registry.values()):
            session.close()
        cls.session.registry.registry.clear()
    engine.dispose()


def native_rpc(monkeypatch):
    rpc = RPC.__new__(RPC)
    rpc._config = {'max_open_trades': 5}
    rpc._force_entry_validations = lambda *args: None

    def callback(*args, **kwargs):
        _CustomData.query_cd(trade_id=123)
        return False

    rpc._freqtrade = SimpleNamespace(_exit_lock=threading.RLock(), execute_entry=callback)
    monkeypatch.setattr(deps, 'get_rpc_optional', lambda: rpc)
    return rpc


async def request(rpc):
    context = deps.get_rpc()
    await anext(context)
    try:
        rpc._rpc_force_entry('TEST/USDT', None, order_type='market', stake_amount=10)
    finally:
        await context.aclose()


def test_native_dependency_alone_leaks_and_exhausts_small_pool(database, monkeypatch):
    rpc = native_rpc(monkeypatch)
    with pytest.raises(RPCException):
        asyncio.run(request(rpc))
    assert database.pool.checkedout() == 1
    with pytest.raises(TimeoutError):
        asyncio.run(request(rpc))


def test_actual_rpc_requests_release_connections_after_callback_exception(database, monkeypatch):
    rpc = native_rpc(monkeypatch)
    monkeypatch.setattr(RPC, '_rpc_force_entry', repair.request_session_cleanup(RPC._rpc_force_entry))
    for _ in range(30):
        with pytest.raises(RPCException, match='Failed to enter position'):
            asyncio.run(request(rpc))
        assert database.pool.checkedout() == 0
        assert not _CustomData.session.registry.registry


@pytest.mark.parametrize('failure', [False, True])
def test_committed_custom_data_survives_cleanup(database, failure):
    @repair.request_session_cleanup
    def operation():
        CustomDataWrapper.set_custom_data(trade_id=123, key='proof', value={'filled': True})
        assert CustomDataWrapper.get_custom_data(trade_id=123, key='proof')[0].value == {'filled': True}
        if failure:
            raise RuntimeError('original-error')
        return 'original-result'

    token = _request_id_ctx_var.set('write-request')
    try:
        if failure:
            with pytest.raises(RuntimeError, match='original-error'):
                operation()
        else:
            assert operation() == 'original-result'
        assert database.pool.checkedout() == 0
        assert CustomDataWrapper.get_custom_data(trade_id=123, key='proof')[0].value == {'filled': True}
        _CustomData.session.remove()
    finally:
        _request_id_ctx_var.reset(token)


def test_does_not_close_background_or_other_request_sessions(database):
    _CustomData.query_cd(trade_id=123)
    background = _CustomData.session()
    repair.request_session_cleanup(lambda: _CustomData.query_cd(trade_id=123))()
    assert _CustomData.session() is background
    assert database.pool.checkedout() == 1
    token = _request_id_ctx_var.set('separate-request')
    try:
        repair.request_session_cleanup(lambda: _CustomData.query_cd(trade_id=123))()
        assert not _CustomData.session.registry.has()
        assert database.pool.checkedout() == 1
    finally:
        _request_id_ctx_var.reset(token)
    assert _CustomData.session() is background
    _CustomData.session.remove()


def test_unused_request_does_not_create_session(database):
    token = _request_id_ctx_var.set('no-custom-data')
    try:
        assert repair.request_session_cleanup(lambda: 42)() == 42
        assert not _CustomData.session.registry.has()
        assert database.pool.checkedout() == 0
    finally:
        _request_id_ctx_var.reset(token)


def test_install_is_idempotent_and_covers_order_callbacks(monkeypatch):
    names = ('_rpc_force_entry', '_rpc_force_exit', '_rpc_cancel_open_order')
    originals = {name: getattr(RPC, name) for name in names}
    for name, method in originals.items():
        monkeypatch.setattr(RPC, name, method)
    repair.install_rpc_session_cleanup()
    installed = {name: getattr(RPC, name) for name in names}
    repair.install_rpc_session_cleanup()
    for name in names:
        assert getattr(RPC, name) is installed[name]
        assert installed[name].__wrapped__ is originals[name]
