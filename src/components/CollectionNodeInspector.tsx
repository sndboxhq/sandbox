import { useState, type ReactNode } from "react";
import type { Workflow, WorkflowNode } from "../types";
import { CustomSelect } from "./ui/CustomSelect";
import { ConfirmDialog } from "./ui/Dialog";
import { IssueNotice } from "./ui/IssueNotice";

type Props={workflow:Workflow;node:WorkflowNode;onChange:(node:WorkflowNode,workflowPatch?:Partial<Workflow>)=>void};
type Rule={id:string;field:string;operator:string;value?:unknown};
type SwitchCase={id:string;name:string;value?:unknown;combinator?:"all"|"any";rules?:Rule[]};
type MergePort={id:string;name:string;required?:boolean};
type PendingRemoval={kind:"case"|"input";connectedCount:number;apply:()=>void};
const operators=["equals","not_equals","exists","not_exists","is_null","is_not_null","is_empty","is_not_empty","contains","not_contains","starts_with","ends_with","greater_than","greater_than_or_equal","less_than","less_than_or_equal","matches_regex","is_one_of","is_not_one_of","array_contains","date_before","date_after","date_between"];

export function CollectionNodeInspector({workflow,node,onChange}:Props){
  const config=node.configuration;
  const set=(key:string,value:unknown)=>onChange({...node,configuration:{...config,[key]:value}});
  const [pendingRemoval,setPendingRemoval]=useState<PendingRemoval>();
  const requestRemoval=(kind:PendingRemoval["kind"],connectedCount:number,apply:()=>void)=>{
    if(!connectedCount){apply();return;}
    setPendingRemoval({kind,connectedCount,apply});
  };
  const removalDialog=<ConfirmDialog
    open={Boolean(pendingRemoval)}
    onOpenChange={(open)=>!open&&setPendingRemoval(undefined)}
    title={`Remove connected ${pendingRemoval?.kind??"item"}?`}
    description={`This also removes ${pendingRemoval?.connectedCount??0} connected branch${pendingRemoval?.connectedCount===1?"":"es"}. The downstream nodes remain on the canvas.`}
    confirmLabel={`Remove ${pendingRemoval?.kind??"item"}`}
    dangerous
    onConfirm={()=>{const removal=pendingRemoval;setPendingRemoval(undefined);removal?.apply();}}
  />;
  if(node.type==="filter")return <>
    <Info>Filter evaluates every workflow item. Condition is the simpler choice for one workflow-level true/false decision.</Info>
    <Field label="Mode"><CustomSelect value={String(config.mode??"keep_matches")} onChange={event=>set("mode",event.target.value)}><option value="keep_matches">Keep matching items</option><option value="remove_matches">Remove matching items</option></CustomSelect></Field>
    <Field label="Rule group"><CustomSelect value={String(config.combinator??"all")} onChange={event=>set("combinator",event.target.value)}><option value="all">All rules must match</option><option value="any">Any rule may match</option></CustomSelect></Field>
    <RuleList rules={(config.rules as Rule[]|undefined)??[]} onChange={rules=>set("rules",rules)}/>
    <Toggle label="Rejected output" hint="Keep removed items available on the named Rejected branch." checked={config.exposeRejected!==false} onChange={value=>set("exposeRejected",value)}/>
  </>;
  if(node.type==="switch")return <>
    <Field label="Routing"><CustomSelect value={String(config.routingMode??"rules")} onChange={event=>set("routingMode",event.target.value)}><option value="rules">Rules per case</option><option value="value">Exact value cases</option></CustomSelect></Field>
    <Field label="Match policy"><CustomSelect value={String(config.mode??"first_match")} onChange={event=>set("mode",event.target.value)}><option value="first_match">First matching case</option><option value="all_matches">All matching cases</option></CustomSelect></Field>
    {config.routingMode==="value"&&<Field label="Value path"><input value={String(config.valuePath??"")} placeholder="status" onChange={event=>set("valuePath",event.target.value)}/></Field>}
    <SwitchCases cases={(config.cases as SwitchCase[]|undefined)??[]} routingMode={String(config.routingMode??"rules")} onChange={(cases,removedId)=>{
      const connected=removedId?workflow.edges.filter(edge=>edge.sourceNodeId===node.id&&edge.sourceHandle===removedId):[];
      const apply=()=>onChange({...node,configuration:{...config,cases}},removedId?{edges:workflow.edges.filter(edge=>!(edge.sourceNodeId===node.id&&edge.sourceHandle===removedId))}:undefined);
      requestRemoval("case",connected.length,apply);
    }}/>
    <Field label="Fallback name"><input value={String(config.fallbackName??"Fallback")} onChange={event=>set("fallbackName",event.target.value)}/></Field>
    <Info>Case IDs stay stable when cases are renamed or reordered, so connected edges keep their identity.</Info>
    {removalDialog}
  </>;
  if(node.type==="split_out")return <>
    <Field label="Array field path" hint="Empty means a top-level array"><input value={String(config.fieldPath??"")} placeholder="response.body.results" onChange={event=>set("fieldPath",event.target.value)}/></Field>
    <Field label="Split value property"><input value={String(config.destinationField??"item")} onChange={event=>set("destinationField",event.target.value)}/></Field>
    <Toggle label="Keep parent fields" checked={config.keepParentFields!==false} onChange={value=>set("keepParentFields",value)}/>
    <Toggle label="Retain original array" checked={Boolean(config.keepOriginalArray)} onChange={value=>set("keepOriginalArray",value)}/>
    <Toggle label="Include original index" checked={config.includeIndex!==false} onChange={value=>set("includeIndex",value)}/>
    <Field label="Empty arrays"><CustomSelect value={String(config.emptyArrayPolicy??"emit_no_items")} onChange={event=>set("emptyArrayPolicy",event.target.value)}><option value="emit_no_items">Emit no items</option><option value="keep_parent">Keep parent item</option><option value="fail">Fail node</option></CustomSelect></Field>
    <Field label="Missing or non-array"><CustomSelect value={String(config.invalidInputPolicy??"fail")} onChange={event=>set("invalidInputPolicy",event.target.value)}><option value="fail">Fail node</option><option value="emit_no_items">Emit no items</option><option value="rejected">Route to Rejected</option></CustomSelect></Field>
  </>;
  if(node.type==="loop_over_items")return <>
    <div className="field-grid"><Field label="Batch size"><input type="number" min="1" max="10000" value={Number(config.batchSize??1)} onChange={event=>set("batchSize",Number(event.target.value))}/></Field><Field label="Concurrency"><input type="number" min="1" max={workflow.settings.collectionLimits?.maxLoopConcurrency??16} value={Number(config.concurrency??1)} onChange={event=>set("concurrency",Number(event.target.value))}/></Field></div>
    <Field label="Maximum iterations"><input type="number" min="1" max={workflow.settings.collectionLimits?.maxLoopIterations??10000} value={Number(config.maxIterations??10000)} onChange={event=>set("maxIterations",Number(event.target.value))}/></Field>
    <Field label="Iteration retries"><input type="number" min="0" max="10" value={Number(config.iterationRetryCount??0)} onChange={event=>set("iterationRetryCount",Number(event.target.value))}/></Field>
    <Field label="Per-item timeout (ms)"><input type="number" min="100" max="600000" value={Number(config.perItemTimeoutMs??30000)} onChange={event=>set("perItemTimeoutMs",Number(event.target.value))}/></Field>
    <Field label="Item failure"><CustomSelect value={String(config.failurePolicy??"stop")} onChange={event=>set("failurePolicy",event.target.value)}><option value="stop">Stop on first failure</option><option value="continue_handled">Continue after handled failures</option></CustomSelect></Field>
    {Number(config.concurrency??1)>1&&<IssueNotice issue={{code:"collection_concurrency",severity:"warning",message:"Concurrent item processing",suggestion:"Body completion order may differ from input order. Review side effects for ordering, retry safety and duplicate effects."}} context={{workflowId:workflow.id,nodeId:node.id}}/>}
    <Info>Iterations have stable IDs and deterministic batch membership. Exactly-once side effects are not promised after uncertain runner loss.</Info>
  </>;
  if(node.type==="aggregate")return <>
    <Field label="Operation"><CustomSelect value={String(config.operation??"collect_items")} onChange={event=>set("operation",event.target.value)}>{["collect_items","collect_field","count","sum","minimum","maximum","average","first","last","concatenate","group_by","object_by_key"].map(value=><option key={value} value={value}>{value.replaceAll("_"," ")}</option>)}</CustomSelect></Field>
    {!['collect_items','count','group_by','object_by_key'].includes(String(config.operation))&&<Field label="Field path"><input value={String(config.fieldPath??"")} onChange={event=>set("fieldPath",event.target.value)}/></Field>}
    {config.operation==="concatenate"&&<Field label="Separator"><input value={String(config.separator??",")} onChange={event=>set("separator",event.target.value)}/></Field>}
    {config.operation==="group_by"&&<Lines label="Group fields" value={(config.groupFields as string[])??[]} onChange={value=>set("groupFields",value)}/>} 
    {config.operation==="object_by_key"&&<><Field label="Key field"><input value={String(config.keyField??"id")} onChange={event=>set("keyField",event.target.value)}/></Field><Field label="Duplicate keys"><CustomSelect value={String(config.duplicateKeyPolicy??"fail")} onChange={event=>set("duplicateKeyPolicy",event.target.value)}><option value="fail">Fail</option><option value="keep_first">Keep first</option><option value="keep_last">Keep last</option></CustomSelect></Field></>}
    {!['collect_items','count'].includes(String(config.operation))&&<Toggle label="Include missing values" hint="Represent missing fields as null where supported." checked={Boolean(config.includeMissing)} onChange={value=>set("includeMissing",value)}/>} 
    <Toggle label="Preserve source lineage" hint="Retain bounded source item IDs in aggregate evidence." checked={Boolean(config.preserveLineage)} onChange={value=>set("preserveLineage",value)}/>
  </>;
  if(node.type==="remove_duplicates")return <>
    <Lines label="Comparison fields" hint="Leave empty for whole-item deep equality" value={(config.fields as string[])??[]} onChange={value=>set("fields",value)}/>
    <Field label="Keep"><CustomSelect value={String(config.keep??"first")} onChange={event=>set("keep",event.target.value)}><option value="first">First item</option><option value="last">Last item</option></CustomSelect></Field>
    <Field label="Scope"><CustomSelect value={String(config.scope??"collection")} onChange={event=>set("scope",event.target.value)}><option value="collection">Current collection</option><option value="workflow_state">Successfully committed runs</option></CustomSelect></Field>
    <Toggle label="Case-sensitive strings" checked={config.caseSensitive!==false} onChange={value=>set("caseSensitive",value)}/><Toggle label="Normalise whitespace" checked={Boolean(config.normalizeWhitespace)} onChange={value=>set("normalizeWhitespace",value)}/>
    <Toggle label="Duplicates output" hint="Keep removed items available on the named Duplicates branch." checked={config.exposeDuplicates!==false} onChange={value=>set("exposeDuplicates",value)}/>
    {config.scope==="workflow_state"&&<Info>Keys are hashed in visible evidence and staged in workflow state. They become seen only if the complete workflow succeeds.</Info>}
  </>;
  if(node.type==="merge")return <>
    <Field label="Mode"><CustomSelect value={String(config.mode??"wait_all")} onChange={event=>set("mode",event.target.value)}>{["wait_all","append","combine_position","combine_fields","cartesian","choose_branch"].map(value=><option key={value} value={value}>{value.replaceAll("_"," ")}</option>)}</CustomSelect></Field>
    <MergePorts ports={(config.inputPorts as MergePort[]|undefined)??[]} onChange={(ports,removedId)=>{
      const connected=removedId?workflow.edges.filter(edge=>edge.targetNodeId===node.id&&(edge.targetPort??edge.targetHandle)===removedId):[];
      const apply=()=>onChange({...node,configuration:{...config,inputPorts:ports,priority:ports.map(port=>port.id)}},removedId?{edges:workflow.edges.filter(edge=>!(edge.targetNodeId===node.id&&(edge.targetPort??edge.targetHandle)===removedId))}:undefined);
      requestRemoval("input",connected.length,apply);
    }}/>
    {config.mode==="combine_position"&&<Field label="Unequal lengths"><CustomSelect value={String(config.unmatchedPolicy??"keep")} onChange={event=>set("unmatchedPolicy",event.target.value)}><option value="keep">Keep unmatched</option><option value="drop">Drop unmatched</option><option value="fail">Fail</option></CustomSelect></Field>}
    {config.mode==="combine_fields"&&<><div className="field-grid"><Field label="Left key"><input value={String(config.leftKey??"id")} onChange={event=>set("leftKey",event.target.value)}/></Field><Field label="Right key"><input value={String(config.rightKey??"id")} onChange={event=>set("rightKey",event.target.value)}/></Field></div><Field label="Join"><CustomSelect value={String(config.join??"inner")} onChange={event=>set("join",event.target.value)}><option value="inner">Inner</option><option value="left">Left</option><option value="right">Right</option><option value="full">Full outer</option></CustomSelect></Field></>}
    {config.mode==="choose_branch"&&<Field label="Choice"><CustomSelect value={String(config.chooseStrategy??"first_non_empty")} onChange={event=>set("chooseStrategy",event.target.value)}><option value="first_non_empty">First non-empty by priority</option><option value="first_successful">First successful by priority</option></CustomSelect></Field>}
    {config.mode==="cartesian"&&<><Field label="Hard result limit"><input type="number" min="1" max={workflow.settings.collectionLimits?.maxCartesianItems??25000} value={Number(config.maxResults??25000)} onChange={event=>set("maxResults",Number(event.target.value))}/></Field><IssueNotice issue={{code:"cartesian_amplification",severity:"warning",message:"Multiplying collections",suggestion:"Preview both input counts before running. The engine rejects products beyond this value or runner policy."}} context={{workflowId:workflow.id,nodeId:node.id}}/></>}
    {["combine_position","combine_fields","cartesian"].includes(String(config.mode))&&<Field label="Property conflicts"><CustomSelect value={String(config.conflictStrategy??"nest")} onChange={event=>set("conflictStrategy",event.target.value)}><option value="nest">Nest by input</option><option value="prefix">Prefix fields</option><option value="prefer_left">Prefer left</option><option value="prefer_right">Prefer right</option><option value="fail">Fail</option></CustomSelect></Field>}
    <Field label="Failed input"><CustomSelect value={String(config.failedInputPolicy??"fail")} onChange={event=>set("failedInputPolicy",event.target.value)}><option value="fail">Fail Merge</option><option value="empty">Treat as empty</option></CustomSelect></Field>
    <Field label="Skipped input"><CustomSelect value={String(config.skippedInputPolicy??"empty")} onChange={event=>set("skippedInputPolicy",event.target.value)}><option value="empty">Treat as empty</option><option value="fail">Fail Merge</option></CustomSelect></Field>
    <Info>Merge uses configured port order, never branch arrival timing. Empty inputs remain visible in execution evidence.</Info>
    {removalDialog}
  </>;
  return null;
}

function RuleList({rules,onChange}:{rules:Rule[];onChange:(rules:Rule[])=>void}){const update=(index:number,patch:Partial<Rule>)=>onChange(rules.map((rule,i)=>i===index?{...rule,...patch}:rule));return <div className="collection-rule-list" aria-label="Rules">{rules.map((rule,index)=><div className="collection-rule" key={rule.id}><Field label={`Rule ${index+1} field`}><input value={rule.field??""} placeholder="status" onChange={event=>update(index,{field:event.target.value})}/></Field><Field label="Operator"><CustomSelect value={rule.operator??"equals"} onChange={event=>update(index,{operator:event.target.value})}>{operators.map(operator=><option key={operator} value={operator}>{operator.replaceAll("_"," ")}</option>)}</CustomSelect></Field>{!['exists','not_exists','is_null','is_not_null','is_empty','is_not_empty'].includes(rule.operator)&&<Field label="Value"><input value={scalar(rule.value)} onChange={event=>update(index,{value:parseScalar(event.target.value)})}/></Field>}<button type="button" className="button" disabled={rules.length===1} onClick={()=>onChange(rules.filter((_,i)=>i!==index))}>Remove rule</button></div>)}<button type="button" className="button" onClick={()=>onChange([...rules,{id:`rule_${crypto.randomUUID().slice(0,8)}`,field:"",operator:"equals",value:""}])}>Add rule</button></div>}
function SwitchCases({cases,routingMode,onChange}:{cases:SwitchCase[];routingMode:string;onChange:(cases:SwitchCase[],removedId?:string)=>void}){const update=(index:number,patch:Partial<SwitchCase>)=>onChange(cases.map((item,i)=>i===index?{...item,...patch}:item));const move=(index:number,offset:number)=>{const target=index+offset;if(target<0||target>=cases.length)return;const next=[...cases];[next[index],next[target]]=[next[target],next[index]];onChange(next)};return <div className="switch-case-list" aria-label="Switch cases">{cases.map((item,index)=><details key={item.id} open={cases.length<4}><summary>{item.name||`Case ${index+1}`} <code>{item.id}</code></summary><Field label="Case name"><input value={item.name??""} onChange={event=>update(index,{name:event.target.value})}/></Field>{routingMode==="value"?<Field label="Exact JSON value"><input value={JSON.stringify(item.value??null)} onChange={event=>update(index,{value:parseScalar(event.target.value)})}/></Field>:<><Field label="Case rules"><CustomSelect value={item.combinator??"all"} onChange={event=>update(index,{combinator:event.target.value as "all"|"any"})}><option value="all">All match</option><option value="any">Any matches</option></CustomSelect></Field><RuleList rules={item.rules??[]} onChange={rules=>update(index,{rules})}/></>}<div className="run-actions"><button type="button" className="button" disabled={index===0} onClick={()=>move(index,-1)}>Move up</button><button type="button" className="button" disabled={index===cases.length-1} onClick={()=>move(index,1)}>Move down</button><button type="button" className="button" disabled={cases.length===1} onClick={()=>onChange(cases.filter((_,i)=>i!==index),item.id)}>Remove case</button></div></details>)}<button type="button" className="button" onClick={()=>onChange([...cases,{id:`case_${crypto.randomUUID().slice(0,8)}`,name:`Case ${cases.length+1}`,combinator:"all",rules:[{id:`rule_${crypto.randomUUID().slice(0,8)}`,field:"",operator:"equals",value:""}]}])}>Add case</button></div>}
function MergePorts({ports,onChange}:{ports:MergePort[];onChange:(ports:MergePort[],removedId?:string)=>void}){const move=(index:number,offset:number)=>{const target=index+offset;if(target<0||target>=ports.length)return;const next=[...ports];[next[index],next[target]]=[next[target],next[index]];onChange(next)};return <div className="merge-port-list" aria-label="Merge input ports">{ports.map((port,index)=><div className="merge-port" key={port.id}><Field label={`Input ${index+1}`}><input value={port.name} onChange={event=>onChange(ports.map((item,i)=>i===index?{...item,name:event.target.value}:item))}/></Field><code>{port.id}</code><div className="run-actions"><button type="button" className="button" disabled={index===0} onClick={()=>move(index,-1)}>Up</button><button type="button" className="button" disabled={index===ports.length-1} onClick={()=>move(index,1)}>Down</button><button type="button" className="button" disabled={ports.length<=2} onClick={()=>onChange(ports.filter((_,i)=>i!==index),port.id)}>Remove</button></div></div>)}<button type="button" className="button" onClick={()=>onChange([...ports,{id:`input_${crypto.randomUUID().slice(0,8)}`,name:`Input ${ports.length+1}`,required:true}])}>Add input</button></div>}
function Field({label,hint,children}:{label:string;hint?:string;children:ReactNode}){return <label className="field"><span>{label}{hint&&<small>{hint}</small>}</span>{children}</label>}
function Toggle({label,hint,checked,onChange}:{label:string;hint?:string;checked:boolean;onChange:(value:boolean)=>void}){return <label className="toggle-row"><span><b>{label}</b>{hint&&<small>{hint}</small>}</span><input type="checkbox" checked={checked} onChange={event=>onChange(event.target.checked)}/></label>}
function Lines({label,hint,value,onChange}:{label:string;hint?:string;value:string[];onChange:(value:string[])=>void}){return <Field label={label} hint={hint}><textarea rows={3} value={value.join("\n")} onChange={event=>onChange(event.target.value.split("\n").map(value=>value.trim()).filter(Boolean))}/></Field>}
function Info({children}:{children:ReactNode}){return <div className="info-note">{children}</div>}
function scalar(value:unknown){return typeof value==="string"?value:JSON.stringify(value??"")}
function parseScalar(value:string):unknown{try{return JSON.parse(value)}catch{return value}}
