import {describe,expect,it} from "vitest";
import {completeCommand,parseCommand,resolveTarget,tokenizeCommand} from "./commandShell";

describe("sndbox command shell",()=>{
  it("tokenizes quoted arguments and flags",()=>expect(parseCommand('workflow create "Nightly report" --template blank')).toMatchObject({path:"workflow create",args:["Nightly report"],flags:{template:"blank"}}));
  it.each(["node list | calc","workflow list > out","run list; clear","help && calc","help `whoami`","help $HOME","help $(whoami)"])("rejects shell syntax in %s",value=>expect(()=>tokenizeCommand(value)).toThrow(/shell syntax/));
  it("does not provide force",()=>expect(()=>parseCommand("workflow archive abc --force")).toThrow(/unavailable/));
  it("completes contextually",()=>expect(completeCommand("workflow v")).toEqual(["workflow validate"]));
  it("resolves ids, prefixes, and names",()=>{const values=[{id:"abc123",name:"One"},{id:"def456",name:"Two"}];expect(resolveTarget("abc123",values).name).toBe("One");expect(resolveTarget("def",values).name).toBe("Two");expect(resolveTarget("one",values).id).toBe("abc123")});
  it("reports ambiguity",()=>expect(()=>resolveTarget("a",[{id:"abc",name:"A"},{id:"abd",name:"B"}])).toThrow(/Ambiguous/));
});
