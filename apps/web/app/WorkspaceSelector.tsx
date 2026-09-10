"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useFormStatus } from "react-dom";
import { setWorkspaceContextAction } from "./actions";

export interface WorkspaceChoice {
  id: string;
  label: string;
  role: string;
}

function WorkspaceSubmit() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? "Switching…" : "Switch"}</button>;
}

export function WorkspaceSelector({ choices, selectedId }: { choices: WorkspaceChoice[]; selectedId?: string }) {
  const pathname = usePathname();
  const search = useSearchParams();
  if (!choices.length) return null;
  const explicitId = search.get("workspaceId") ?? undefined;
  const currentId = choices.some((choice) => choice.id === explicitId) ? explicitId : selectedId;
  const returnTo = `${pathname}${search.size ? `?${search.toString()}` : ""}`;
  return (
    <form action={setWorkspaceContextAction} className="portal-global-workspace">
      <label htmlFor="global-workspace"><span>Current workspace</span></label>
      <div>
        <select id="global-workspace" name="workspaceId" value={currentId} aria-label="Current workspace" onChange={(event) => event.currentTarget.form?.requestSubmit()}>
          {choices.map((choice) => <option value={choice.id} key={choice.id}>{choice.label} · {choice.role}</option>)}
        </select>
        <input type="hidden" name="returnTo" value={returnTo} />
        <WorkspaceSubmit />
      </div>
    </form>
  );
}
