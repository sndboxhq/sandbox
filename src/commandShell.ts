export const COMMAND_PATHS = [
  "help","clear","history",
  ...["workflows","history","plugins","cloud","approvals","settings"].map(value=>`go ${value}`),
  ...["list","open","create","run","validate","diagnose","permissions","revisions","duplicate","enable","disable","archive","import","export"].map(value=>`workflow ${value}`),
  ...["list","add","select","test","customize","contract","gates","web-builder","unlink","enable","disable","delete"].map(value=>`node ${value}`),
  ...["list","show","logs","cancel","retry"].map(value=>`run ${value}`),
  ...["status","pause","resume"].map(value=>`runner ${value}`),
  "plugin list","plugin open","connection list","connection test","approval list","approval open",
  "app launcher","app shortcuts","app settings","app version",
] as const;

export interface ParsedCommand { path:string; args:string[]; flags:Record<string,string|boolean>; raw:string }

export function tokenizeCommand(raw:string):string[]{
  const source=raw.trim();
  if(!source)return[];
  if(/[|;<>`]/.test(source)||/&&|\$\(|\$\{|\$[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%/.test(source))throw new Error("OS shell syntax is not supported. Use sndbox commands, arguments, and flags only.");
  const tokens:string[]=[];let current="",quote:"'"|'"'|undefined,escaping=false;
  for(const character of source){
    if(escaping){current+=character;escaping=false;continue}
    if(character==="\\"&&quote==='"'){escaping=true;continue}
    if(quote){if(character===quote)quote=undefined;else current+=character;continue}
    if(character==='"'||character==="'"){quote=character;continue}
    if(/\s/.test(character)){if(current){tokens.push(current);current=""}continue}
    current+=character;
  }
  if(quote)throw new Error("Unterminated quoted argument.");
  if(escaping)current+="\\";
  if(current)tokens.push(current);
  return tokens;
}

export function parseCommand(raw:string):ParsedCommand{
  const tokens=tokenizeCommand(raw);
  if(!tokens.length)throw new Error("Enter a sndbox command. Try `help`.");
  const candidate=tokens.slice(0,2).join(" ").toLowerCase();
  const single=tokens[0].toLowerCase();
  const path=(COMMAND_PATHS as readonly string[]).includes(candidate)?candidate:(COMMAND_PATHS as readonly string[]).includes(single)?single:"";
  if(!path)throw new Error(`Unknown sndbox command '${candidate}'. Try \`help\`.`);
  const consumed=path.includes(" ")?2:1,args:string[]=[],flags:Record<string,string|boolean>={};
  for(let index=consumed;index<tokens.length;index++){
    const token=tokens[index];
    if(!token.startsWith("--")){args.push(token);continue}
    const body=token.slice(2);if(!body||body==="force")throw new Error(body==="force"?"--force is intentionally unavailable.":"Flag name is missing.");
    const equals=body.indexOf("=");
    if(equals>=0){flags[body.slice(0,equals)]=body.slice(equals+1);continue}
    const next=tokens[index+1];
    if(next&&!next.startsWith("--")){flags[body]=next;index++}else flags[body]=true;
  }
  return{path,args,flags,raw:sourceWithoutSensitiveWhitespace(raw)};
}

export function completeCommand(input:string):string[]{
  const normalized=input.trimStart().toLowerCase();
  return [...COMMAND_PATHS].filter(path=>path.startsWith(normalized)).slice(0,12);
}

export interface TargetLike { id:string; name:string }
export function resolveTarget<T extends TargetLike>(query:string,targets:T[]):T{
  const exact=targets.find(item=>item.id===query);if(exact)return exact;
  const prefixes=targets.filter(item=>item.id.toLowerCase().startsWith(query.toLowerCase()));
  if(prefixes.length===1)return prefixes[0];
  const names=targets.filter(item=>item.name.toLowerCase()===query.toLowerCase());
  const matches=[...new Map([...prefixes,...names].map(item=>[item.id,item])).values()];
  if(matches.length===1)return matches[0];
  if(matches.length>1)throw new Error(`Ambiguous target '${query}': ${matches.map(item=>`${item.name} (${item.id})`).join(", ")}`);
  throw new Error(`No target matches '${query}'.`);
}

const sourceWithoutSensitiveWhitespace=(value:string)=>value.trim().replace(/\s+/g," ");

export function shouldPersistCommand(command:ParsedCommand):boolean{
  return !Object.keys(command.flags).some(key=>/secret|token|password|credential/i.test(key))
    && !/\b(secret|token|password|credential)\b/i.test(command.path);
}
