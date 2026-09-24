// Synthetic API reply, never a model or exchange call.
export function kevReply(request,{choice='approve',model='gpt-6-luna',now=Date.now()}={}){
 const autonomous=request.state?.decisionMode==='autonomous';
 const answer=autonomous?(()=>{
  const criteria=Object.keys(request.questions.entry?.criteria??{}),selected=criteria.includes(choice)?choice:'hold';
  const probabilities=Object.fromEntries(criteria.map(key=>[key,key===selected ? 0.9 : 0.1/(Math.max(1,criteria.length-1))]));
  return {type:'choice',choice:selected,confidence:.8,probabilities};
 })():null;
 return {model:'kev-codex',answers:autonomous?{entry:answer}:Object.fromEntries(Object.keys(request.questions).map(q=>[q,
  {type:'choice',choice,confidence:.8,probabilities:choice==='approve'?{approve:.9,hold:.1}:{approve:.1,hold:.9}}])),
  request_id:'synthetic-fixture',created_at:new Date(now).toISOString(),usage:{input_tokens:100,output_tokens:20},
  backend:{name:'codex-cli',actual_model:model,weights_loaded:false,probabilities_calibrated:false,cli_calls:1}};
}
