import {ChevronDown,ExternalLink,TerminalSquare,X} from "lucide-react";
import {useEffect,useMemo,useRef,useState} from "react";
import {api} from "../api";
import {completeCommand,parseCommand,resolveTarget,shouldPersistCommand,type ParsedCommand} from "../commandShell";
import {useAppStore,type View} from "../store";
import type {ExecutionRecord,Workflow,WorkflowNode} from "../types";
import "../commandShell.css";

type Link={label:string;detail?:string;action:()=>void};
type Entry={id:string;kind:"command"|"output"|"error";text:string;links?:Link[]};
type Pending={command:ParsedCommand;description:string};
const HISTORY_KEY="sndbox.command-history.v1";
const views=new Set(["workflows","history","plugins","cloud","approvals","settings"]);

export function CommandShell({open,onOpenChange,onShortcuts,onLauncher}:{open:boolean;onOpenChange:(open:boolean)=>void;onShortcuts:()=>void;onLauncher:()=>void}){
  const [input,setInput]=useState("");const [entries,setEntries]=useState<Entry[]>([]);const [pending,setPending]=useState<Pending>();const [history,setHistory]=useState<string[]>(()=>{try{return JSON.parse(localStorage.getItem(HISTORY_KEY)??"[]")}catch{return[]}});const [historyIndex,setHistoryIndex]=useState(-1);const [busy,setBusy]=useState(false);
  const inputRef=useRef<HTMLInputElement>(null),endRef=useRef<HTMLDivElement>(null);
  const completions=useMemo(()=>completeCommand(input),[input]);
  useEffect(()=>{if(open)window.setTimeout(()=>inputRef.current?.focus(),0)},[open]);
  useEffect(()=>endRef.current?.scrollIntoView({block:"nearest"}),[entries,pending]);
  useEffect(()=>{const listener=()=>{onOpenChange(true);window.setTimeout(()=>inputRef.current?.focus(),0)};window.addEventListener("sandbox:open-command-shell",listener);return()=>window.removeEventListener("sandbox:open-command-shell",listener)},[onOpenChange]);
  const push=(entry:Omit<Entry,"id">)=>setEntries(current=>[...current,{...entry,id:crypto.randomUUID()}].slice(-500));
  const remember=(parsed:ParsedCommand)=>{if(!shouldPersistCommand(parsed))return;setHistory(current=>{const next=[...current.filter(value=>value!==parsed.raw),parsed.raw].slice(-100);localStorage.setItem(HISTORY_KEY,JSON.stringify(next));return next})};
  const submit=async(raw=input,confirmed=false)=>{
    let parsed:ParsedCommand;try{parsed=parseCommand(raw)}catch(error){push({kind:"error",text:String(error)});return}
    if(!confirmed)push({kind:"command",text:`sndbox> ${parsed.raw}`});remember(parsed);setInput("");setHistoryIndex(-1);
    const confirmation=confirmationFor(parsed);
    if(confirmation&&!confirmed){setPending({command:parsed,description:confirmation});return}
    setPending(undefined);setBusy(true);
    try{const result=await execute(parsed,{onShortcuts,onLauncher});if(result.clear)setEntries([]);else push({kind:"output",text:result.text,links:result.links})}catch(error){push({kind:"error",text:String(error)})}finally{setBusy(false)}
  };
  if(!open)return <button className="command-shell-tab" onClick={()=>onOpenChange(true)}><TerminalSquare size={13}/> sndbox console <kbd>Ctrl K</kbd></button>;
  return <section className="command-shell" aria-label="sndbox command console">
    <header><TerminalSquare size={14}/><b>Command console</b><span>sndbox commands only · output stays in memory</span><button aria-label="Collapse console" onClick={()=>onOpenChange(false)}><ChevronDown size={14}/></button><button aria-label="Clear transcript" onClick={()=>setEntries([])}><X size={14}/></button></header>
    <div className="command-transcript" role="log" aria-live="polite">
      {!entries.length&&<div className="command-welcome"><b>sndbox&gt;</b> Type <code>help</code> to see workflow, node, run, runner, plugin, connection, approval, and app commands.</div>}
      {entries.map(entry=><div key={entry.id} className={`command-entry command-entry-${entry.kind}`}><pre>{entry.text}</pre>{entry.links?.map((link,index)=><button key={`${entry.id}-${index}`} onClick={link.action}><span>{link.label}</span>{link.detail&&<small>{link.detail}</small>}<ExternalLink size={11}/></button>)}</div>)}
      {pending&&<div className="command-confirm" role="alert"><b>Confirmation required</b><p>{pending.description}</p><code>{pending.command.raw}</code><div><button onClick={()=>setPending(undefined)}>Cancel</button><button className="danger" onClick={()=>void submit(pending.command.raw,true)}>Confirm</button></div></div>}
      <div ref={endRef}/>
    </div>
    <form className="command-prompt" onSubmit={event=>{event.preventDefault();if(!busy)void submit()}}><b>sndbox&gt;</b><input ref={inputRef} value={input} onChange={event=>setInput(event.target.value)} aria-label="sndbox command" autoComplete="off" placeholder="help" onKeyDown={event=>{
      if(event.key==="Tab"&&completions[0]){event.preventDefault();setInput(completions[0]+" ")}
      if(event.key==="ArrowUp"){event.preventDefault();const next=Math.min(history.length-1,historyIndex+1);setHistoryIndex(next);setInput(history[history.length-1-next]??"")}
      if(event.key==="ArrowDown"){event.preventDefault();const next=Math.max(-1,historyIndex-1);setHistoryIndex(next);setInput(next<0?"":history[history.length-1-next]??"")}
    }}/><button disabled={busy||!input.trim()}>{busy?"Running…":"Run"}</button></form>
    {input&&completions.length>0&&<div className="command-completions" role="listbox">{completions.map(value=><button key={value} type="button" onMouseDown={event=>event.preventDefault()} onClick={()=>{setInput(value+" ");inputRef.current?.focus()}}>{value}</button>)}</div>}
  </section>
}

function confirmationFor(command:ParsedCommand){
  if(["workflow run","workflow archive","node delete","node test","run cancel","run retry","connection test"].includes(command.path))return "This command changes workflow state, starts work, or performs an externally consequential check. It uses the same application guardrails as the graphical control.";
  return undefined;
}

async function execute(command:ParsedCommand,ui:{onShortcuts:()=>void;onLauncher:()=>void}):Promise<{text:string;links?:Link[];clear?:boolean}>{
  const store=useAppStore.getState();const target=command.args.join(" ");
  if(command.path==="help")return{text:"Commands:\n  go workflows|history|plugins|cloud|approvals|settings\n  workflow list|open|create|run|validate|duplicate|enable|disable|archive|import|export\n  node list|add|select|test|customize|enable|disable|delete\n  run list|show|cancel|retry\n  runner status|pause|resume\n  plugin list|open · connection list|test · approval list|open\n  app launcher|shortcuts|settings\n\nTargets accept an exact ID, unique ID prefix, or unique case-insensitive name. Pipes, redirects, chaining, substitutions, environment expansion, executables, and --force are rejected."};
  if(command.path==="clear")return{text:"",clear:true};
  if(command.path==="history"){let values:string[]=[];try{values=JSON.parse(localStorage.getItem(HISTORY_KEY)??"[]")}catch{}return{text:values.map((value,index)=>`${index+1}  ${value}`).join("\n")||"No stored command history."}}
  if(command.path.startsWith("go ")){const view=command.path.slice(3) as View;if(views.has(view)){store.setView(view);return{text:`Opened ${view}.`}}}
  if(command.path==="workflow list"){const items=await api.listWorkflows(Boolean(command.flags.archived));return{text:`${items.length} workflow(s).`,links:items.map(item=>({label:item.workflow.name,detail:item.workflow.id,action:()=>void useAppStore.getState().openWorkflow(item.workflow.id)}))}}
  if(command.path==="workflow create"){await store.createWorkflow(typeof command.flags.template==="string"?command.flags.template:undefined,target||undefined);return{text:`Created ${useAppStore.getState().activeWorkflow?.name??"workflow"}.`}}
  if(command.path==="workflow import"){const imported=await api.importWorkflow();if(imported){await store.load();await store.openWorkflow(imported.id)}return{text:imported?`Imported ${imported.name} disabled for review.`:"Import cancelled."}}
  const workflowCommands=["workflow open","workflow run","workflow validate","workflow duplicate","workflow enable","workflow disable","workflow archive","workflow export"];
  if(workflowCommands.includes(command.path)){
    const workflow=await resolveWorkflow(target,store.activeWorkflow);
    if(command.path==="workflow open"){guardUnsaved();await store.openWorkflow(workflow.id);return{text:`Opened ${workflow.name}.`}}
    if(command.path==="workflow run"){const run=await api.runWorkflow(workflow.id);return{text:`Run ${run.id} finished ${run.status}.`,links:[{label:"Open run",detail:run.id,action:()=>{useAppStore.getState().selectExecution(run);useAppStore.getState().setView("history")}}]}}
    if(command.path==="workflow validate"){const issues=await api.validateWorkflow(workflow);return{text:issues.length?issues.map(issue=>`${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`).join("\n"):"Workflow is valid."}}
    if(command.path==="workflow duplicate"){const copy=await api.duplicateWorkflow(workflow.id,typeof command.flags.name==="string"?command.flags.name:undefined);await store.load();return{text:`Duplicated as ${copy.name} (${copy.id}).`}}
    if(command.path==="workflow archive"){await api.archiveWorkflow(workflow.id);await store.load();return{text:`Archived ${workflow.name}.`}}
    if(command.path==="workflow export"){const path=await api.exportWorkflow(workflow.id);return{text:path?`Exported to ${path}.`:"Export cancelled."}}
    const saved=await store.saveWorkflow({...workflow,enabled:command.path.endsWith("enable")});return{text:`${saved.name} is now ${saved.enabled?"enabled":"disabled"}.`}
  }
  if(command.path.startsWith("node "))return executeNode(command,store.activeWorkflow);
  if(command.path==="run list"){const runs=await api.listExecutions(undefined,100);return{text:`${runs.length} run(s).`,links:runs.map(run=>runLink(run))}}
  if(["run show","run cancel","run retry"].includes(command.path)){if(!target)throw new Error("Provide a run ID.");const run=await api.getExecution(target);if(!run)throw new Error(`No run matches '${target}'.`);if(command.path==="run show")return{text:JSON.stringify(run,null,2)};if(command.path==="run cancel"){await api.cancelExecution(run.id);return{text:`Cancellation requested for ${run.id}.`}}const failed=run.nodeExecutions.find(node=>node.status==="failed");if(!failed)throw new Error("That run has no failed node to retry.");const retry=await api.retryFailedNode(run.id,failed.nodeId);return{text:`Retry ${retry.id} finished ${retry.status}.`,links:[runLink(retry)]}}
  if(command.path.startsWith("runner ")){if(command.path!=="runner status")await api.setRunnerPaused(command.path==="runner pause");const status=await api.runnerStatus();return{text:`Runner ${status.paused?"paused":"active"}; ${status.activeWorkflowIds.length} active, ${status.scheduledWorkflowCount} scheduled.`}}
  if(command.path==="plugin list"){const plugins=await api.listInstalledPlugins();return{text:`${plugins.length} plugin(s).`,links:plugins.map(plugin=>({label:plugin.manifest.name,detail:`${plugin.state} · ${plugin.pluginId}`,action:()=>store.setView("plugins")}))}}
  if(command.path==="plugin open"){store.setView("plugins");return{text:"Opened Plugins."}}
  if(command.path==="connection list"){const connections=await api.listConnections();return{text:`${connections.length} connection(s).`,links:connections.map(connection=>({label:connection.displayName,detail:`${connection.provider} · ${connection.status}`,action:()=>{sessionStorage.setItem("sandbox:settings-section","connections");store.setView("settings")}}))}}
  if(command.path==="connection test"){const connections=await api.listConnections();const connection=resolveTarget(target,connections.map(item=>({...item,name:item.displayName})));const result=await api.testConnection(connection.id);return{text:result.message}}
  if(command.path==="approval list"){const approvals=await api.listPendingApprovals();return{text:`${approvals.length} pending approval(s).`,links:approvals.map(item=>({label:`${item.action.type??"Approval"}`,detail:item.id,action:()=>store.setView("approvals")}))}}
  if(command.path==="approval open"){store.setView("approvals");return{text:"Opened Pending approvals."}}
  if(command.path==="app launcher"){ui.onLauncher();return{text:"Opened quick launcher."}}
  if(command.path==="app shortcuts"){ui.onShortcuts();return{text:"Opened keyboard shortcuts."}}
  if(command.path==="app settings"){store.setView("settings");return{text:"Opened Settings."}}
  throw new Error(`Command '${command.path}' is unavailable in this context.`);
}

async function executeNode(command:ParsedCommand,active?:Workflow){if(!active)throw new Error("Open a workflow before using node commands.");const query=command.args.join(" ");
  if(command.path==="node list")return{text:`${active.nodes.length} node(s).`,links:active.nodes.map(node=>({label:node.name,detail:`${node.type} · ${node.id}`,action:()=>dispatchNode("select",node)}))};
  if(command.path==="node add"){window.dispatchEvent(new CustomEvent("sandbox:open-node-picker",{detail:{query}}));return{text:"Opened the node picker. Choose the matching contract."}}
  const node=resolveTarget(query,active.nodes.map(item=>({...item,id:item.id,name:item.name} as WorkflowNode&{id:string;name:string})));
  if(command.path==="node select"){dispatchNode("select",node);return{text:`Selected ${node.name}.`}}
  if(command.path==="node customize"){dispatchNode("customize",node);return{text:`Opened a custom draft based on ${node.name} v${node.version}.`}}
  if(command.path==="node test"){const run=await api.testWorkflowNode(active,node.id,{},undefined,false);return{text:`Node test ${run.status}.`}}
  if(command.path==="node enable"||command.path==="node disable"){dispatchNode(command.path.endsWith("enable")?"enable":"disable",node);return{text:`${node.name} ${command.path.endsWith("enable")?"enabled":"disabled"}.`}}
  if(command.path==="node delete"){dispatchNode("delete",node);return{text:`Delete requested for ${node.name}.`}}
  throw new Error(`Command '${command.path}' is unavailable.`)
}
function dispatchNode(action:string,node:WorkflowNode){window.dispatchEvent(new CustomEvent("sandbox:node-command",{detail:{action,nodeId:node.id}}))}
function guardUnsaved(){if((window as Window&{__sandboxUnsaved?:boolean}).__sandboxUnsaved)throw new Error("The editor has unsaved changes. Save or discard them before switching workflows.")}
async function resolveWorkflow(query:string,active?:Workflow){if(!query&&active)return active;if(!query)throw new Error("Provide a workflow target or open one first.");const items=await api.listWorkflows(true);return resolveTarget(query,items.map(item=>({...item.workflow,id:item.workflow.id,name:item.workflow.name}))) as Workflow}
function runLink(run:ExecutionRecord):Link{return{label:`${run.status} · ${new Date(run.startedAt).toLocaleString()}`,detail:run.id,action:()=>{useAppStore.getState().selectExecution(run);useAppStore.getState().setView("history")}}}
