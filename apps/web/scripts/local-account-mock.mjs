import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

const accountId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const organisationId="11111111-1111-4111-8111-111111111111";
const workspaceId="22222222-2222-4222-8222-222222222222";
const environmentId="88888888-8888-4888-8888-888888888888";
const now=new Date().toISOString();
const later=new Date(Date.now()+2_592_000_000).toISOString();
const profile={accountId,email:"alex@northstar.io",displayName:"Alex Morgan",sessionId};
const organisation={id:organisationId,name:"Northstar Ops",slug:"northstar-ops",role:"owner",createdAt:now,workspaces:[{id:workspaceId,organisationId,name:"Production",slug:"production",role:"owner",createdAt:now}]};
let runners=[
  {runnerId:"33333333-3333-4333-8333-333333333333",displayName:"Production EU-1",workspaceId,operatingSystem:"linux",architecture:"x86_64",applicationVersion:"0.7.9-beta.1",protocolVersion:1,status:"online",currentWorkload:2,tags:["production","eu-west"],pairedAt:now,lastSeenAt:now},
  {runnerId:"44444444-4444-4444-8444-444444444444",displayName:"Backup ARM",workspaceId,operatingSystem:"linux",architecture:"aarch64",applicationVersion:"0.7.9-beta.1",protocolVersion:1,status:"offline",currentWorkload:0,tags:["backup"],pairedAt:now,lastSeenAt:null}
];
let tokens=[{id:"55555555-5555-4555-8555-555555555555",name:"CLI access",prefix:"sbx_dev",kind:"personal",scopes:["workflows.view"],organisationId,workspaceIds:[workspaceId],environmentIds:[],createdAt:now,expiresAt:later,lastUsedAt:now,revokedAt:null}];
let walletBalanceMicros=12_450_000;
let walletEntries=[
  {id:"aaaaaaaa-0000-4000-8000-000000000001",kind:"top_up",amountMicros:20_000_000,balanceAfterMicros:20_000_000,description:"Cloud credit top-up · $20.00",createdAt:new Date(Date.now()-8*86_400_000).toISOString()},
  {id:"aaaaaaaa-0000-4000-8000-000000000002",kind:"usage",amountMicros:-4_930_000,balanceAfterMicros:15_070_000,description:"Cloud usage · 7c12a3de",createdAt:new Date(Date.now()-3*86_400_000).toISOString()},
  {id:"aaaaaaaa-0000-4000-8000-000000000003",kind:"usage",amountMicros:-2_620_000,balanceAfterMicros:12_450_000,description:"Cloud usage · 31fb82c0",createdAt:new Date(Date.now()-86_400_000).toISOString()},
];
const walletRates={currency:"usd",minimumComputeSeconds:60,hostedRunnerMicrosPerMinute:5_000,managedBrowserMicrosPerMinute:10_000,networkEgressMicrosPerGib:200_000,artifactStorageMicrosPerGibMonth:50_000};
const referralSummary={code:"4f9a9d7b3c6e2a10",shareUrl:"http://localhost:3000/r/4f9a9d7b3c6e2a10",policy:{claimWindowDays:7,qualifyingTopUpCents:1_000,rewardMicros:5_000_000,maximumRewardsPerRollingYear:50},stats:{invited:3,pending:1,rewarded:2,earnedMicros:10_000_000},claim:null,referrals:[{id:"aaaaaaaa-0000-4000-8000-000000000011",status:"rewarded",claimedAt:new Date(Date.now()-12*86_400_000).toISOString(),rewardedAt:new Date(Date.now()-11*86_400_000).toISOString(),reversedAt:null},{id:"aaaaaaaa-0000-4000-8000-000000000012",status:"pending",claimedAt:new Date(Date.now()-2*86_400_000).toISOString(),rewardedAt:null,reversedAt:null},{id:"aaaaaaaa-0000-4000-8000-000000000013",status:"rewarded",claimedAt:new Date(Date.now()-24*86_400_000).toISOString(),rewardedAt:new Date(Date.now()-23*86_400_000).toISOString(),reversedAt:null}]};

function json(response,status,data){response.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});response.end(JSON.stringify(data));}
function usageSummary(){
  const daily=Array.from({length:30},(_,index)=>{
    const date=new Date(Date.now()-(29-index)*86_400_000).toISOString().slice(0,10);
    const hosted=index%7===0?0:600+(index%5)*180;
    const browser=index%4===0?240:0;
    return{date,quantities:{hosted_runner_seconds:hosted,managed_browser_seconds:browser,network_egress_bytes:(index%3+1)*1_048_576,artifact_storage_byte_seconds:1_073_741_824*86_400}};
  });
  const units={hosted_runner_seconds:"seconds",managed_browser_seconds:"seconds",network_egress_bytes:"bytes",artifact_storage_byte_seconds:"byte_seconds"};
  const meters=Object.entries(units).map(([meter,unit])=>({meter,unit,quantity:daily.reduce((total,point)=>total+point.quantities[meter],0)}));
  return{workspaceId,periodStartedAt:`${daily[0].date}T00:00:00.000Z`,periodEndedAt:new Date().toISOString(),reconciliation:"matched",meters,daily};
}

createServer((request,response)=>{
  let body="";
  request.on("data",chunk=>body+=chunk);
  request.on("end",()=>{
    if(request.headers.authorization!=="Bearer preview-token")return json(response,401,{error:{code:"invalid_session"}});
    const url=new URL(request.url,"http://127.0.0.1"),path=url.pathname,method=request.method;
    let input={};try{input=body?JSON.parse(body):{};}catch{}
    if(method==="GET"&&path==="/v1/account/profile")return json(response,200,profile);
    if(method==="GET"&&path==="/v1/account/organisations")return json(response,200,{items:[organisation]});
    if(method==="GET"&&path==="/v1/account/commerce")return json(response,200,{subscriptions:[{id:"sub_dev",ownerType:"personal",ownerId:accountId,planId:"team",planName:"Team",status:"active",currentPeriodEndsAt:later,cancelAtPeriodEnd:false}],licences:[{id:"lic_dev",ownerType:"personal",ownerId:accountId,planId:"team",status:"active",seatAllowance:5,seatsAssigned:2,devices:3,offlineGraceUntil:later}]});
    if(method==="GET"&&path==="/v1/account/wallet")return json(response,200,{currency:"usd",balanceMicros:walletBalanceMicros,status:walletBalanceMicros<=0?"empty":walletBalanceMicros<1_000_000?"low":"funded",rates:walletRates,recentEntries:walletEntries});
    if(method==="GET"&&path==="/v1/account/referrals")return json(response,200,referralSummary);
    if(method==="POST"&&path==="/v1/account/referrals/claim")return json(response,200,{claimed:true,status:"pending"});
    if(method==="POST"&&path==="/v1/account/wallet/top-ups"){
      const amountCents=Number(input.amountCents);if(!Number.isInteger(amountCents)||amountCents<500||amountCents>50_000)return json(response,400,{error:{code:"topup_amount_invalid",message:"Choose a top-up between $5 and $500."}});
      const amountMicros=amountCents*10_000;walletBalanceMicros+=amountMicros;walletEntries=[{id:randomUUID(),kind:"top_up",amountMicros,balanceAfterMicros:walletBalanceMicros,description:`Cloud credit top-up · $${(amountCents/100).toFixed(2)}`,createdAt:new Date().toISOString()},...walletEntries];
      return json(response,200,{checkout:{checkoutId:`cs_local_${randomBytes(8).toString("hex")}`,url:"http://localhost:3000/billing?topup=success",expiresAt:later}});
    }
    if(method==="GET"&&path==="/v1/account/sessions")return json(response,200,{items:[{id:sessionId,deviceName:"Chrome on Windows",createdAt:now,lastSeenAt:now,expiresAt:later,current:true},{id:"66666666-6666-4666-8666-666666666666",deviceName:"Firefox on Linux",createdAt:now,lastSeenAt:now,expiresAt:later,current:false}]});
    if(method==="GET"&&path==="/v1/personal-access-tokens")return json(response,200,{items:tokens});
    if(method==="POST"&&path==="/v1/personal-access-tokens"){
      const item={id:randomUUID(),name:input.name||"Local key",prefix:"sbx_pair",kind:"personal",scopes:input.scopes||[],organisationId:input.organisationId||organisationId,workspaceIds:input.workspaceIds||[workspaceId],environmentIds:[],createdAt:now,expiresAt:later,lastUsedAt:null,revokedAt:null};
      tokens.push(item);return json(response,201,{credential:{...item,token:`sbx_local_${randomBytes(24).toString("base64url")}`}});
    }
    if(method==="DELETE"&&path.startsWith("/v1/personal-access-tokens/")){tokens=tokens.filter(token=>token.id!==path.split("/").at(-1));return json(response,200,{revoked:true});}
    if(method==="GET"&&path===`/v1/workspaces/${workspaceId}/runners`)return json(response,200,{items:runners});
    if(method==="GET"&&path===`/v1/workspaces/${workspaceId}/runner-pools`)return json(response,200,{items:[{id:"77777777-7777-4777-8777-777777777777",workspaceId,environmentId,name:"Production pool",strategy:"least_loaded",region:"eu-west",requiredTags:["production"],maximumConcurrency:4,status:"active",memberCount:1,createdAt:now,updatedAt:now}]});
    if(method==="GET"&&path===`/v1/workspaces/${workspaceId}/environments`)return json(response,200,{items:[{environmentId,environment:"production"},{environmentId:"99999999-9999-4999-8999-999999999999",environment:"staging"},{environmentId:"00000000-0000-4000-8000-000000000000",environment:"development"}]});
    if(method==="GET"&&path===`/v1/workspaces/${workspaceId}/activity`)return json(response,200,{runners,runs:[],pendingApprovalCount:0,webhookFailureCount:0});
    if(method==="GET"&&path===`/v1/workspaces/${workspaceId}/usage`)return json(response,200,usageSummary());
    if(method==="GET"&&path==="/v1/product-plans")return json(response,200,{items:[]});
    if(method==="PATCH"&&path.includes("/runners/")){
      const runnerId=path.split("/").at(-1);runners=runners.map(runner=>runner.runnerId===runnerId?{...runner,status:input.status??runner.status}:runner);return json(response,200,{updated:true});
    }
    if(method==="GET")return json(response,200,{items:[]});
    return json(response,200,{ok:true});
  });
}).listen(3999,"127.0.0.1",()=>console.log("local account service ready on 3999"));
