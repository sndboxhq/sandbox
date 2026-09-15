import { Check, Copy, Link2, LockKeyhole, LogOut, Share2, UsersRound, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import type { CollaborationSessionHandle, DecryptedCollaborationPresence } from "../types";
import { Dialog } from "./ui/Dialog";
import "../collaboration.css";

export function CollaborationDialog({
  open,
  onOpenChange,
  handle,
  participants,
  busy,
  error,
  defaultWorkspaceId,
  onStart,
  onJoin,
  onLeave,
}: {
  open:boolean;
  onOpenChange:(open:boolean)=>void;
  handle?:CollaborationSessionHandle;
  participants:DecryptedCollaborationPresence[];
  busy:boolean;
  error?:string;
  defaultWorkspaceId:string;
  onStart:(workspaceId:string)=>void;
  onJoin:(inviteCode:string)=>void;
  onLeave:()=>void;
}) {
  const [workspaceId,setWorkspaceId]=useState(defaultWorkspaceId);
  const [inviteCode,setInviteCode]=useState("");
  const [copied,setCopied]=useState(false);
  useEffect(()=>{if(defaultWorkspaceId&&!workspaceId)setWorkspaceId(defaultWorkspaceId)},[defaultWorkspaceId,workspaceId]);
  useEffect(()=>{if(!copied)return;const timer=window.setTimeout(()=>setCopied(false),1800);return()=>window.clearTimeout(timer)},[copied]);
  const copyInvite=async()=>{
    if(!handle)return;
    await navigator.clipboard.writeText(handle.inviteCode);
    setCopied(true);
  };
  return <Dialog
    open={open}
    onOpenChange={onOpenChange}
    title={handle?"Live canvas":"Share this canvas"}
    description={handle?"Edits are end-to-end encrypted and ordered for everyone in this session.":"Start a secure session or join one with an invite code."}
    width="large"
  >
    {handle?<div className="collaboration-session">
      <div className="collaboration-live-card">
        <span className="collaboration-live-icon"><Wifi size={17}/></span>
        <div><b>Live and encrypted</b><small>{participants.length||1} editor{(participants.length||1)===1?"":"s"} online · session ends {new Date(handle.session.expiresAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</small></div>
        <span className="collaboration-live-pill">Live</span>
      </div>
      <section className="collaboration-section">
        <header><div><h3>Invite editors</h3><p>Anyone with this code still needs edit access to the workspace. The encryption key is in the code and never sent to sndbox servers.</p></div><LockKeyhole size={17}/></header>
        <div className="collaboration-invite-row">
          <textarea readOnly value={handle.inviteCode} aria-label="Collaboration invite code" rows={3}/>
          <button className="button" onClick={()=>void copyInvite()}>{copied?<Check size={14}/>:<Copy size={14}/>} {copied?"Copied":"Copy invite"}</button>
        </div>
      </section>
      <section className="collaboration-section">
        <header><div><h3>People here</h3><p>Selection presence is encrypted alongside workflow edits.</p></div><UsersRound size={17}/></header>
        <div className="collaboration-people">
          {participants.map(person=><div key={`${person.accountId}:${person.deviceId}`} className="collaboration-person">
            <span className="collaboration-avatar" style={{background:person.color}}>{initials(person.displayName)}</span>
            <span><b>{person.displayName}</b><small>{person.payload.selectedNodeIds.length?`Editing ${person.payload.selectedNodeIds.length} step${person.payload.selectedNodeIds.length===1?"":"s"}`:"Viewing canvas"}</small></span>
          </div>)}
          {!participants.length&&<div className="collaboration-waiting"><UsersRound size={18}/><span>Waiting for encrypted presence…</span></div>}
        </div>
      </section>
      {error&&<p className="collaboration-error" role="alert">{error}</p>}
      <div className="collaboration-footer"><span>Session <code>{handle.session.sessionId.slice(0,8)}</code></span><button className="button danger" disabled={busy} onClick={onLeave}><LogOut size={14}/> {busy?"Leaving…":"Leave session"}</button></div>
    </div>:<div className="collaboration-setup">
      <article className="collaboration-option collaboration-option-primary">
        <span className="collaboration-option-icon"><Share2 size={20}/></span>
        <div><h3>Start from this workflow</h3><p>The workflow must already be synced to the selected workspace. Your current canvas becomes the encrypted session baseline.</p></div>
        <label className="field"><span>Workspace ID</span><input value={workspaceId} onChange={event=>setWorkspaceId(event.target.value.trim())} placeholder="Workspace UUID" autoComplete="off"/></label>
        <button className="button primary" disabled={busy||!workspaceId} onClick={()=>onStart(workspaceId)}>{busy?"Starting…":"Start secure session"}</button>
      </article>
      <div className="collaboration-divider"><span>or</span></div>
      <article className="collaboration-option">
        <span className="collaboration-option-icon"><Link2 size={20}/></span>
        <div><h3>Join with an invite</h3><p>Open the matching workflow, paste the private invite code, and receive the latest encrypted canvas changes.</p></div>
        <label className="field"><span>Invite code</span><textarea value={inviteCode} onChange={event=>setInviteCode(event.target.value)} rows={4} placeholder="sndbox-collab-v1.…" autoComplete="off" spellCheck={false}/></label>
        <button className="button" disabled={busy||!inviteCode.trim()} onClick={()=>onJoin(inviteCode.trim())}>{busy?"Joining…":"Join canvas"}</button>
      </article>
      {error&&<p className="collaboration-error" role="alert">{error}</p>}
    </div>}
  </Dialog>;
}

function initials(name:string){
  const value=name.trim().split(/\s+/).slice(0,2).map(part=>part[0]).join("").toUpperCase();
  return value||"?";
}
