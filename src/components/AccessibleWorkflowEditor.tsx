import { useEffect, useState } from "react";
import { isAnnotation, isTrigger } from "../catalogue";
import type { Workflow } from "../types";
import {
  connectWorkflowNodes,
  disconnectWorkflowEdge,
  isValidWorkflowConnection,
  WEB_BUILDER_INPUT_PORTS,
  webBuilderPortForTarget,
} from "../workflowConnections";
import { CustomSelect } from "./ui/CustomSelect";

const STEP = 20;

export function AccessibleWorkflowEditor({ workflow, selectedNodeId, onChange, onSelect, onAddNode }: {
  workflow: Workflow;
  selectedNodeId?: string;
  onChange: (workflow: Workflow, announcement: string) => void;
  onSelect: (nodeId: string) => void;
  onAddNode: () => void;
}) {
  const [sourceId, setSourceId] = useState(workflow.nodes.find(node=>!isAnnotation(node.type))?.id ?? "");
  const [targetId, setTargetId] = useState("");
  const [sourceHandle, setSourceHandle] = useState("output");
  const [targetHandle, setTargetHandle] = useState("input");
  const source = workflow.nodes.find(node => node.id === sourceId);
  const connectionNodes = workflow.nodes.filter(node=>!isAnnotation(node.type));
  const targets = connectionNodes.filter(node => node.id !== sourceId && !isTrigger(node.type));
  const target = workflow.nodes.find(node => node.id === targetId);
  const sourcePorts=accessibleSourcePorts(source);
  const targetPorts=accessibleTargetPorts(target);

  useEffect(() => {
    if (!connectionNodes.some(node => node.id === sourceId)) setSourceId(connectionNodes[0]?.id ?? "");
  }, [sourceId, workflow.nodes]);

  useEffect(() => {
    if (!targets.some(node => node.id === targetId)) setTargetId(targets[0]?.id ?? "");
  }, [targetId, targets]);

  useEffect(() => {
    setSourceHandle(accessibleSourcePorts(source)[0]?.id??"output");
  }, [source?.type, source?.configuration, sourceId]);

  useEffect(() => {
    setTargetHandle(accessibleTargetPorts(target)[0]?.id??webBuilderPortForTarget(target));
  }, [target?.id, target?.type, target?.configuration]);

  const move = (nodeId: string, dx: number, dy: number, direction: string) => {
    const node = workflow.nodes.find(candidate => candidate.id === nodeId);
    if (!node) return;
    onChange({ ...workflow, nodes: workflow.nodes.map(candidate => candidate.id === nodeId
      ? { ...candidate, position: { x: candidate.position.x + dx, y: candidate.position.y + dy } }
      : candidate) }, `${node.name} moved ${direction} ${STEP} pixels.`);
  };

  const connect = () => {
    if (!source || !targetId || source.id === targetId) return;
    if (!target || isTrigger(target.type)) return;
    const next = connectWorkflowNodes(workflow, {
      source: source.id,
      target: targetId,
      sourceHandle,
      targetHandle,
    });
    if (!next) {
      onChange(workflow, `That connection is not compatible or the ${targetHandle} input is already connected.`);
      return;
    }
    onChange(next, `Connected ${source.name} to ${target.name}${targetPorts.length ? ` at its ${targetHandle} input` : sourcePorts.length>1 ? ` on the ${sourceHandle} branch` : ""}.`);
  };

  const validConnection = Boolean(source && target && isValidWorkflowConnection(workflow, {
    source: source?.id ?? null,
    target: target?.id ?? null,
    sourceHandle,
    targetHandle,
  }));

  return <aside className="accessible-workflow-editor" id="accessible-workflow-editor" aria-labelledby="accessible-editor-title" tabIndex={-1}>
    <header><div><h2 id="accessible-editor-title">Accessible graph editor</h2><p>Move, connect, inspect, and remove connections without dragging.</p></div><button className="button" onClick={onAddNode}>Add node</button></header>
    <section aria-labelledby="accessible-nodes-title">
      <h3 id="accessible-nodes-title">Nodes</h3>
      <ol className="accessible-node-list">
        {workflow.nodes.map(node => <li key={node.id} className={selectedNodeId === node.id ? "selected" : ""}>
          <button className="accessible-node-select" aria-pressed={selectedNodeId === node.id} onClick={() => onSelect(node.id)}><b>{node.name}</b><span>{node.type.replaceAll("_", " ")} · x {Math.round(node.position.x)}, y {Math.round(node.position.y)}</span></button>
          <div className="accessible-move-controls" aria-label={`Move ${node.name}`}>
            <button onClick={() => move(node.id, 0, -STEP, "up")} aria-label={`Move ${node.name} up`}>↑</button>
            <button onClick={() => move(node.id, -STEP, 0, "left")} aria-label={`Move ${node.name} left`}>←</button>
            <button onClick={() => move(node.id, STEP, 0, "right")} aria-label={`Move ${node.name} right`}>→</button>
            <button onClick={() => move(node.id, 0, STEP, "down")} aria-label={`Move ${node.name} down`}>↓</button>
          </div>
        </li>)}
      </ol>
    </section>
    <section aria-labelledby="accessible-connect-title">
      <h3 id="accessible-connect-title">Add connection</h3>
      <div className="accessible-connection-form">
        <label htmlFor="accessible-source">From</label><CustomSelect id="accessible-source" value={sourceId} onChange={event => setSourceId(event.target.value)}>{connectionNodes.map(node => <option value={node.id} key={node.id}>{node.name}</option>)}</CustomSelect>
        {sourcePorts.length>1 && <><label htmlFor="accessible-branch">Branch</label><CustomSelect id="accessible-branch" value={sourceHandle} onChange={event => setSourceHandle(event.target.value)}>{sourcePorts.map(port=><option value={port.id} key={port.id}>{port.label}</option>)}</CustomSelect></>}
        <label htmlFor="accessible-target">To</label><CustomSelect id="accessible-target" value={targetId} onChange={event => setTargetId(event.target.value)} disabled={!targets.length}>{targets.map(node => <option value={node.id} key={node.id}>{node.name}</option>)}</CustomSelect>
        {targetPorts.length>0 && <><label htmlFor="accessible-target-input">Input</label><CustomSelect id="accessible-target-input" value={targetHandle} onChange={event => setTargetHandle(event.target.value)}>{targetPorts.map(port => <option value={port.id} key={port.id}>{port.label}</option>)}</CustomSelect></>}
        <button className="button primary" disabled={!validConnection} onClick={connect}>Add connection</button>
      </div>
    </section>
    <section aria-labelledby="accessible-connections-title">
      <h3 id="accessible-connections-title">Connections</h3>
      {workflow.edges.length === 0 ? <p className="accessible-empty">No connections.</p> : <ul className="accessible-edge-list">{workflow.edges.map(edge => {
        const from = workflow.nodes.find(node => node.id === edge.sourceNodeId)?.name ?? edge.sourceNodeId;
        const to = workflow.nodes.find(node => node.id === edge.targetNodeId)?.name ?? edge.targetNodeId;
        const description = `${from}${edge.sourceHandle === "output" ? "" : ` (${edge.sourceHandle})`} to ${to}${edge.targetHandle === "input" ? "" : ` (${edge.targetHandle} input)`}`;
        return <li key={edge.id}><span>{description}</span><button aria-label={`Remove connection ${description}`} onClick={() => onChange(disconnectWorkflowEdge(workflow, edge.id), `Removed connection ${description}.`)}>Remove</button></li>;
      })}</ul>}
    </section>
  </aside>;
}

function accessibleSourcePorts(node:Workflow["nodes"][number]|undefined):Array<{id:string;label:string}>{
  if(!node)return[{id:"output",label:"Output"}];
  if(node.type==="condition")return[{id:"true",label:"True"},{id:"false",label:"False"}];
  if(node.type==="switch")return[...(((node.configuration.cases as Array<{id:string;name:string}>|undefined)??[]).map(item=>({id:item.id,label:item.name}))),{id:String(node.configuration.fallbackBranchId??"fallback"),label:String(node.configuration.fallbackName??"Fallback")}];
  if(node.type==="filter")return[{id:"output",label:"Retained"},{id:"rejected",label:"Rejected"}];
  if(node.type==="split_out")return[{id:"output",label:"Items"},{id:"rejected",label:"Rejected"}];
  if(node.type==="loop_over_items")return[{id:"loop",label:"Loop"},{id:"done",label:"Done"}];
  if(node.type==="remove_duplicates")return[{id:"output",label:"Unique"},{id:"duplicates",label:"Duplicates"}];
  return[{id:"output",label:"Output"}];
}
function accessibleTargetPorts(node:Workflow["nodes"][number]|undefined):Array<{id:string;label:string}>{if(node?.type==="web_builder")return WEB_BUILDER_INPUT_PORTS.map(port=>({id:port.id,label:port.label}));if(node?.type==="merge")return((node.configuration.inputPorts as Array<{id:string;name:string}>|undefined)??[]).map(port=>({id:port.id,label:port.name}));return[]}
