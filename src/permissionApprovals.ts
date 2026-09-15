import type {Workflow} from "./types";

export function workflowSemanticSignature(workflow:Workflow){
  return JSON.stringify({
    triggerNodeId:workflow.triggerNodeId,
    nodes:workflow.nodes.filter(node=>node.type!=="note").map(node=>({id:node.id,type:node.type,version:node.version,configuration:node.configuration,disabled:node.disabled,inputBindings:node.inputBindings,plugin:node.plugin,customization:node.customization,errorPolicy:node.errorPolicy})).sort((left,right)=>left.id.localeCompare(right.id)),
    edges:workflow.edges.map(edge=>({id:edge.id,sourceNodeId:edge.sourceNodeId,sourceHandle:edge.sourceHandle,targetNodeId:edge.targetNodeId,targetHandle:edge.targetHandle})).sort((left,right)=>left.id.localeCompare(right.id)),
  });
}

export function invalidatePermissionApprovals(previous:Workflow,next:Workflow):Workflow{
  if(workflowSemanticSignature(previous)===workflowSemanticSignature(next))return next;
  return{...next,settings:{...next.settings,permissions:{
    ...next.settings.permissions,approvedFolders:[],approvedNetworkDomains:[],commandExecutionPermitted:false,backgroundExecutionPermitted:false,
    approvalRevision:null,approvedBrowserProfileIds:[],browserAutomationPermitted:false,externalCommunicationPermitted:false,
    externalDataWritePermitted:false,communicationApprovalRevision:null,approvedEnvironmentVariables:[],
  }}};
}
