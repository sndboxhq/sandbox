import {describe,expect,it,vi} from "vitest";
import {snapshotCollaborativeWorkflow} from "./collaboration";
import {bootstrapCollaborativeWorkflow} from "./collaborationBootstrap";
import type {CollaborationSessionHandle,Workflow} from "./types";

const workflow=():Workflow=>({id:"10000000-0000-4000-8000-000000000001",schemaVersion:7,name:"Shared",description:"",enabled:true,triggerNodeId:"trigger",nodes:[{id:"trigger",type:"manual_trigger",version:1,name:"Manual",position:{x:0,y:0},configuration:{},disabled:false}],edges:[],settings:{defaultNodeTimeoutMs:30_000,maxConcurrentNodes:4,permissions:{approvedFolders:["C:/private"],approvedNetworkDomains:["private.test"],commandExecutionPermitted:true,backgroundExecutionPermitted:true,approvedBrowserProfileIds:[],browserAutomationPermitted:false,externalCommunicationPermitted:false}},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
const handle:CollaborationSessionHandle={session:{sessionId:"20000000-0000-4000-8000-000000000002",workspaceId:"30000000-0000-4000-8000-000000000003",workflowId:"10000000-0000-4000-8000-000000000001",latestSequence:1,joinedAt:new Date().toISOString(),expiresAt:new Date().toISOString()},inviteCode:"private"};

describe("collaboration bootstrap",()=>{
  it("creates a disabled local workflow from encrypted operation pages with empty approvals",async()=>{
    vi.stubGlobal("crypto",{randomUUID:()=>"40000000-0000-4000-8000-000000000004"});
    const safe=workflow();safe.enabled=false;safe.settings.permissions.approvedFolders=[];safe.settings.permissions.approvedNetworkDomains=[];
    const payload=snapshotCollaborativeWorkflow(safe,"host",0);
    const result=await bootstrapCollaborativeWorkflow(handle,undefined,async()=>({latestSequence:1,items:[{sessionId:handle.session.sessionId,sequence:1,operationId:payload.operationId,workflowId:safe.id,actorAccountId:"50000000-0000-4000-8000-000000000005",baseSequence:0,clientSequence:1,payload,createdAt:payload.createdAt,acceptedAt:payload.createdAt}]}));
    expect(result.workflow).toMatchObject({id:safe.id,name:"Shared",enabled:false});
    expect(result.workflow.settings.permissions).toMatchObject({approvedFolders:[],approvedNetworkDomains:[],commandExecutionPermitted:false,backgroundExecutionPermitted:false});
    vi.unstubAllGlobals();
  });
});
