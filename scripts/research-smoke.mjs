import { web3 } from '../src/research.mjs';
const cases=[
 ['query-token-info','search',{keyword:'BTC',chainIds:'56'}],
 ['query-token-audit','audit',{binanceChainId:'56',contractAddress:'0x55d398326f99059ff775485246999027b3197955'}],
 ['crypto-market-rank','token-rank',{rankType:10,chainId:'56',page:1,size:5}],
 ['query-address-info','positions',{address:'0x000000000000000000000000000000000000dEaD',chainId:'56',offset:0}]
];
for(const [skill,command,p] of cases){
 try{const r=await web3(skill,command,p);console.log(JSON.stringify({skill,status:r.status,source:r.source,fetchedAt:r.fetchedAt}));}
 catch(e){console.log(JSON.stringify({skill,status:'error',error:e.message}));process.exitCode=1;}
}
