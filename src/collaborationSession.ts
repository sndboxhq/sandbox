import type { CollaborationSessionHandle } from "./types";

export interface LiveCollaborationState {
  handle:CollaborationSessionHandle;
  appliedSequence:number;
  clientSequence:number;
}

const sessions=new Map<string,LiveCollaborationState>();
const deviceStorageKey="sandbox.collaboration.device.v1";
const colors=["#6f8fff", "#c77dff", "#33b895", "#ef8c5a", "#e35d8f", "#4da3d9"];

export function collaborationDeviceIdentity(){
  const stored=localStorage.getItem(deviceStorageKey);
  if(stored&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(stored))return stored;
  const created=crypto.randomUUID();localStorage.setItem(deviceStorageKey,created);return created;
}

export function collaborationDeviceColor(deviceId:string){
  const score=[...deviceId].reduce((value,character)=>value+character.charCodeAt(0),0);
  return colors[score%colors.length];
}

export function rememberCollaborationSession(state:LiveCollaborationState){
  sessions.set(state.handle.session.workflowId,state);
}

export function collaborationSessionFor(workflowId:string){
  return sessions.get(workflowId);
}

export function forgetCollaborationSession(workflowId:string){
  sessions.delete(workflowId);
}
