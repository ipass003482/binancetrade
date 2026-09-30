export const reviewerErrors={
 PROVIDER_STATE_INVALID:'設定資料不完整，暫時無法切換。',PROVIDER_IO_ERROR:'無法讀取或儲存本機設定，請稍後再試。',PROVIDER_BUSY:'另一個設定動作正在處理，請稍後再試。',PROVIDER_REVISION_CONFLICT:'設定已在其他分頁更新。已重新讀取狀態，請確認後再切換。',PROVIDER_INVALID:'審核器設定無效。',
 JEV_KEY_INVALID:'金鑰格式不正確，請重新輸入。',JEV_KEY_MISSING:'請先儲存 Jev API key。',JEV_KEY_NOT_VERIFIED:'金鑰尚未通過驗證，無法切換到 Jev。',JEV_SECRET_FAILED:'本機加密儲存失敗，金鑰無法使用。',JEV_HTTP_AUTH:'Jev 拒絕此金鑰，請確認金鑰與存取權限。',JEV_HTTP_RATE_LIMIT:'Jev 目前限制請求頻率，請稍後再驗證。',JEV_HTTP_ERROR:'Jev 驗證服務回傳錯誤，請稍後再試。',JEV_NETWORK_ERROR:'無法連線至 Jev 驗證服務。',JEV_TIMEOUT:'Jev 驗證逾時，請稍後再試。',JEV_RESPONSE_INVALID:'Jev 驗證回應無效。',JEV_RESPONSE_TOO_LARGE:'Jev 驗證回應超出限制。',JEV_MODEL_UNAVAILABLE:'此金鑰無法存取指定的 jev-1.13.0 模型。',
 JEV_ABORTED:'Jev 驗證已中止，請稍後再試。',JEV_CLOCK_INVALID:'本機時間無法確認，暫時無法驗證。',JEV_TIMEOUT_INVALID:'驗證服務時間設定無效。',JEV_REQUEST_INVALID:'驗證請求無效。',
 REVIEWER_CSRF_REJECTED:'設定頁驗證已過期。已重新讀取狀態，請再操作一次。',LOCAL_ORIGIN_REQUIRED:'請從本機 127.0.0.1:18100 開啟設定頁。',REVIEWER_BODY_INVALID:'設定內容不正確，請重新輸入。',REVIEWER_BODY_TOO_LARGE:'金鑰長度超出限制。',REVIEWER_UNAVAILABLE:'目前無法確認審核器設定，請重新讀取。'
};
const knownCode=value=>Object.hasOwn(reviewerErrors,value)?value:'REVIEWER_UNAVAILABLE';
function checkedStatus(raw){
 if(!raw||!['kev','jev'].includes(raw.provider)||typeof raw.model!=='string'||typeof raw.keyConfigured!=='boolean'||typeof raw.keyVerified!=='boolean'||
  !raw.jev||raw.jev.model!=='jev-1.13.0'||typeof raw.csrfToken!=='string'||!/^[a-f0-9]{64}$/.test(raw.csrfToken)||
  !(raw.revision===null||typeof raw.revision==='string'))throw Object.assign(Error(),{code:'REVIEWER_UNAVAILABLE'});
 return {provider:raw.provider,model:raw.model,revision:raw.revision,changedAt:raw.changedAt,credentialId:raw.credentialId,
  keyConfigured:raw.keyConfigured,keyVerified:raw.keyVerified,verifiedAt:raw.verifiedAt,jev:{model:raw.jev.model,credentialId:raw.jev.credentialId,verificationStatus:raw.jev.verificationStatus}};
}
export class ReviewerSettingsStore extends EventTarget{
 constructor({fetchImpl=(...args)=>globalThis.fetch(...args)}={}){super();this.fetchImpl=fetchImpl;this.state={status:null,loading:false,busy:false,errorCode:null,notice:null};this.csrfToken=null;this.sequence=0;}
 emit(){this.dispatchEvent(new Event('change'));}
 async request(path,options){let response,body;try{response=await this.fetchImpl(path,{cache:'no-store',credentials:'omit',...options});body=await response.json();}catch{throw Object.assign(Error(),{code:'REVIEWER_UNAVAILABLE'});}
  if(!response.ok)throw Object.assign(Error(),{code:knownCode(body?.error)});return body;}
 accept(body){const status=checkedStatus(body);this.csrfToken=body.csrfToken;this.state.status=status;}
 async refresh({keepMessage=false}={}){if(this.state.busy)return false;const seq=++this.sequence;this.state.loading=true;if(!keepMessage){this.state.errorCode=null;this.state.notice=null;}this.emit();
  try{const body=await this.request('/api/reviewer/status');if(seq!==this.sequence)return false;this.accept(body);return true;}
  catch(error){if(seq!==this.sequence)return false;this.state.status=null;this.csrfToken=null;this.state.errorCode=knownCode(error.code);return false;}
  finally{if(seq===this.sequence){this.state.loading=false;this.emit();}}
 }
 async mutate(path,body,notice){if(this.state.busy||this.state.loading||!this.state.status||!this.csrfToken)return false;this.sequence++;this.state.busy=true;this.state.errorCode=null;this.state.notice=null;this.emit();let errorCode=null;
  try{this.accept(await this.request(path,{method:'POST',headers:{'Content-Type':'application/json','X-Reviewer-CSRF':this.csrfToken},body:JSON.stringify(body)}));this.state.notice=notice;return true;}
  catch(error){errorCode=knownCode(error.code);return false;}
  finally{this.state.busy=false;if(errorCode){this.state.errorCode=errorCode;await this.refresh({keepMessage:true});if(this.state.status)this.state.errorCode=errorCode;}this.emit();}
 }
 async saveKey(apiKey){if(typeof apiKey!=='string'||!apiKey.length||apiKey.length>4096||/[\x00-\x20\x7f]/.test(apiKey)){this.state.errorCode='JEV_KEY_INVALID';this.emit();return false;}
  return this.mutate('/api/reviewer/jev-key',{apiKey},'Jev 金鑰已驗證。請選擇「切換到 Jev」才會套用至新決策。');}
 async switchProvider(provider){if(!['kev','jev'].includes(provider)||!this.state.status||provider==='jev'&&!this.state.status.keyVerified)return false;
  return this.mutate('/api/reviewer/switch',{provider,expectedRevision:this.state.status.revision,...(provider==='jev'?{expectedCredentialId:this.state.status.jev.credentialId}:{})},'已切換至 '+(provider==='jev'?'Jev':'Kev')+'，之後的新決策將使用此審核器。');}
}
