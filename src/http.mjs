export async function jsonFetch(url, {method='GET',body,headers={},timeoutMs=12000,fetchImpl=fetch}={}) {
 const response=await fetchImpl(url,{method,redirect:'error',signal:AbortSignal.timeout(timeoutMs),
   headers:{Accept:'application/json',...headers,...(body!==undefined?{'Content-Type':'application/json'}:{})},
   ...(body!==undefined?{body:JSON.stringify(body)}:{})});
 if(!response.ok) throw new Error('HTTP_'+response.status);
 const text=await response.text();
 if(text.length>4000000) throw new Error('RESPONSE_TOO_LARGE');
 let result;
 try { result=JSON.parse(text); } catch { throw new Error('INVALID_JSON_RESPONSE'); }
 if(result?.success===false || (result?.code!==undefined && ![0,'0','000000','00000000'].includes(result.code)))
   throw new Error('UPSTREAM_ERROR');
 return result;
}
