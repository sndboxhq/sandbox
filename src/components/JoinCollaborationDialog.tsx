import { Link2, LockKeyhole } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import "../collaboration.css";
import "../joinCollaboration.css";

export function JoinCollaborationDialog({open,onOpenChange,inviteCode,onInviteCodeChange,busy,error,onJoin}:{
  open:boolean;onOpenChange:(open:boolean)=>void;inviteCode:string;onInviteCodeChange:(value:string)=>void;busy:boolean;error?:string;onJoin:()=>void;
}){
  return <Dialog open={open} onOpenChange={onOpenChange} title="Join a live canvas" description="Receive the encrypted workflow baseline and continue editing together." width="medium" footer={<><button className="button" disabled={busy} onClick={()=>onOpenChange(false)}>Cancel</button><button className="button primary" disabled={busy||!inviteCode.trim()} onClick={onJoin}>{busy?"Decrypting canvas…":"Join canvas"}</button></>}>
    <div className="collaboration-join-standalone">
      <span className="collaboration-option-icon"><Link2 size={20}/></span>
      <div><h3>Private invite code</h3><p>The code contains the end-to-end encryption key. It is kept in memory and the operating-system vault, and is excluded from command history.</p></div>
      <label className="field"><span>Invite code</span><textarea autoFocus value={inviteCode} onChange={event=>onInviteCodeChange(event.target.value)} rows={5} placeholder="sndbox-collab-v1.…" autoComplete="off" spellCheck={false}/></label>
      <div className="collaboration-security-note"><LockKeyhole size={15}/><span>You must also have workflow edit access in the invite's workspace. The imported local workflow starts disabled with no inherited approvals.</span></div>
      {error&&<p className="collaboration-error" role="alert">{error}</p>}
    </div>
  </Dialog>;
}
