import { applyCollaborationOperation, parseCollaborationOperation } from "./collaboration";
import type { CollaborationOperationPage, CollaborationSessionHandle, PermissionSummary, Workflow } from "./types";

export const emptyCollaborationPermissions=():PermissionSummary=>({
  approvedFolders:[],approvedNetworkDomains:[],commandExecutionPermitted:false,backgroundExecutionPermitted:false,
  approvalRevision:null,approvedBrowserProfileIds:[],browserAutomationPermitted:false,externalCommunicationPermitted:false,
  externalDataWritePermitted:false,communicationApprovalRevision:null,approvedEnvironmentVariables:[],
});

export async function bootstrapCollaborativeWorkflow(
  handle:CollaborationSessionHandle,
  existing:Workflow|undefined,
  poll:(after:number)=>Promise<CollaborationOperationPage>,
):Promise<{workflow:Workflow;appliedSequence:number}>{
  let workflow=existing?{...structuredClone(existing),enabled:false,settings:{...structuredClone(existing.settings),permissions:emptyCollaborationPermissions()}}:undefined;
  let sequence=0;
  for(let pageIndex=0;pageIndex<200;pageIndex++){
    const page=await poll(sequence);
    const items=[...page.items].sort((left,right)=>left.sequence-right.sequence);
    for(const item of items){
      if(item.sequence<=sequence)continue;
      if(item.sequence!==sequence+1)throw new Error(`The shared canvas history has a sequence gap at ${sequence+1}.`);
      const operation=parseCollaborationOperation(item.payload,{workflowId:handle.session.workflowId,operationId:item.operationId,baseSequence:item.baseSequence});
      if(!workflow){
        const snapshot=operation.changes.find(change=>change.kind==="workflow_snapshot");
        if(!snapshot)throw new Error("The shared canvas did not provide its encrypted baseline.");
        workflow={...structuredClone(snapshot.workflow),enabled:false,settings:{...structuredClone(snapshot.workflow.settings),permissions:emptyCollaborationPermissions()}};
      }
      workflow=applyCollaborationOperation(workflow,operation);
      workflow.enabled=false;
      workflow.settings.permissions=emptyCollaborationPermissions();
      sequence=item.sequence;
    }
    if(sequence>=page.latestSequence){
      if(!workflow)throw new Error("The shared canvas is empty and cannot be opened.");
      return{workflow,appliedSequence:sequence};
    }
    if(!items.length)throw new Error("The shared canvas history is incomplete.");
  }
  throw new Error("The shared canvas history is too large to bootstrap safely.");
}
