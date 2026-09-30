// Public decision provenance. No credentials or mutable runtime selection here.
export const JEV_ENTRY_VERSION='jev-typesafe-entry-v1';
export const JEV_MODEL='jev-1.13.0';
export const JEV_BASE_URL='https://api.typesafe.ai';
export const isJevConfig=config=>config?.version===JEV_ENTRY_VERSION;
export const reviewerProvider=config=>isJevConfig(config)?'typesafe-api':'codex-cli';
export function decisionProviderEvidence(config){
 return config?.providerRevision?{provider:reviewerProvider(config),model:config.expectedModel,revision:config.providerRevision}:null;
}
export function reviewerBackendMatches(result,config,digest){
 const b=result?.backend,jev=isJevConfig(config);
 if(result?.model!==config.model||b?.name!==reviewerProvider(config)||b.actual_model!==config.expectedModel||
    b.weights_loaded!==false||b.probabilities_calibrated!==false||
    typeof result.request_id!=='string'||!result.request_id||result.request_id.length>100||
    !Number.isInteger(result.usage?.input_tokens)||result.usage.input_tokens<1||
    !Number.isInteger(result.usage?.output_tokens)||result.usage.output_tokens<(jev?0:1))return false;
 if(!jev)return b.cli_calls===1;
 return config.model===JEV_MODEL&&config.expectedModel===JEV_MODEL&&config.baseUrl===JEV_BASE_URL&&
  b.api_calls===1&&!Object.hasOwn(b,'cli_calls')&&b.request_id_source==='host'&&b.timestamp_source==='host'&&
  result.upstream?.model===JEV_MODEL&&digest(result.answers)===digest(result.upstream.answers)&&
  digest(result.usage)===digest(result.upstream.usage);
}
