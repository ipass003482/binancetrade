import { isDemo,isFutures } from './mode.mjs';
export function makeEngineConfig(policy,auth){
 const demo=isDemo(policy.mode),futures=isFutures(policy.mode);
 return {
  bot_name:policy.freqtrade.botName,strategy:policy.freqtrade.strategy,dry_run:!demo,...(!demo?{dry_run_wallet:1000}:{}),
  trading_mode:futures?'futures':'spot',margin_mode:futures?'isolated':'',...(futures?{liquidation_buffer:0.1}: {}),max_open_trades:policy.maxOpenTrades,
  stake_currency:'USDT',stake_amount:Number(policy.maxStakeUsdt),tradable_balance_ratio:0.99,
  fiat_display_currency:'',timeframe:'15m',cancel_open_orders_on_exit:true,
  initial_state:'running',force_entry_enable:true,position_adjustment_enable:false,
  minimal_roi:{'0':0.03,'120':0.015,'360':0.005},stoploss:-0.02,
  unfilledtimeout:{entry:5,exit:5,exit_timeout_count:0,unit:'minutes'},
  entry_pricing:{price_side:'other',use_order_book:true,order_book_top:1,price_last_balance:0},
  exit_pricing:{price_side:'other',use_order_book:true,order_book_top:1},
  order_types:{entry:'market',exit:'market',emergency_exit:'market',force_entry:'market',force_exit:'market',stoploss:'market',stoploss_on_exchange:false},
  exchange:{name:'binance',key:'',secret:'',...(demo?{demo_trading:true,enable_ws:false}:{}),
   ccxt_config:{enableRateLimit:true},ccxt_async_config:{enableRateLimit:true},pair_whitelist:policy.pairs,pair_blacklist:[]},
  pairlists:[{method:'StaticPairList'}],telegram:{enabled:false,token:'',chat_id:''},
  api_server:{enabled:true,listen_ip_address:'127.0.0.1',listen_port:Number(new URL(policy.freqtrade.url).port),
   verbosity:'error',enable_openapi:false,jwt_secret_key:auth.jwtSecret,ws_token:auth.wsToken,CORS_origins:[],
   username:auth.username,password:auth.password},
  internals:{process_throttle_secs:5}
 };
}
