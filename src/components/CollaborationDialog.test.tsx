import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborationSessionHandle, DecryptedCollaborationPresence } from "../types";
import { CollaborationDialog } from "./CollaborationDialog";
import { JoinCollaborationDialog } from "./JoinCollaborationDialog";

describe("collaboration dialogs", () => {
  afterEach(cleanup);

  it("exposes labelled keyboard-operable start and join paths", () => {
    const onStart = vi.fn();
    const onJoin = vi.fn();
    render(
      <CollaborationDialog
        open
        onOpenChange={vi.fn()}
        participants={[]}
        busy={false}
        defaultWorkspaceId=""
        onStart={onStart}
        onJoin={onJoin}
        onLeave={vi.fn()}
      />,
    );

    const start = screen.getByRole("button", { name: "Start secure session" });
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Workspace ID"), { target: { value: "workspace-1" } });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledWith("workspace-1");

    const join = screen.getByRole("button", { name: "Join canvas" });
    expect(join).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Invite code"), { target: { value: "sndbox-collab-v1.secret" } });
    fireEvent.click(join);
    expect(onJoin).toHaveBeenCalledWith("sndbox-collab-v1.secret");
  });

  it("labels live-session controls and participant state", () => {
    const now = new Date();
    const handle: CollaborationSessionHandle = {
      inviteCode: "sndbox-collab-v1.private",
      session: {
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        workflowId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        latestSequence: 2,
        joinedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      },
    };
    const participants: DecryptedCollaborationPresence[] = [{
      accountId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      displayName: "Ada Lovelace",
      color: "#6f8fff",
      payload: { selectedNodeIds: ["node-1"] },
      lastSeenAt: now.toISOString(),
    }];
    const onLeave = vi.fn();
    render(
      <CollaborationDialog
        open
        onOpenChange={vi.fn()}
        handle={handle}
        participants={participants}
        busy={false}
        defaultWorkspaceId=""
        onStart={vi.fn()}
        onJoin={vi.fn()}
        onLeave={onLeave}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Live canvas" })).toBeInTheDocument();
    expect(screen.getByLabelText("Collaboration invite code")).toHaveAttribute("readonly");
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Editing 1 step")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave session" }));
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("keeps the standalone invite input labelled and reports errors", () => {
    const onInviteCodeChange = vi.fn();
    render(
      <JoinCollaborationDialog
        open
        onOpenChange={vi.fn()}
        inviteCode=""
        onInviteCodeChange={onInviteCodeChange}
        busy={false}
        error="Invite expired"
        onJoin={vi.fn()}
      />,
    );
    const invite = screen.getByLabelText("Invite code");
    fireEvent.change(invite, { target: { value: "private" } });
    expect(onInviteCodeChange).toHaveBeenCalledWith("private");
    expect(screen.getByRole("alert")).toHaveTextContent("Invite expired");
    expect(screen.getByRole("button", { name: "Join canvas" })).toBeDisabled();
  });
});
