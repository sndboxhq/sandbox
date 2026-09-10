import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPreferences, usePreferences } from "../preferences";
import { DesktopUpdateNotice } from "./DesktopUpdateNotice";
import { ToastProvider } from "./ui/Toast";

const mocks = vi.hoisted(() => ({
  checkForDesktopUpdateStatus: vi.fn(),
  openUrl: vi.fn()
}));

vi.mock("../updates", () => ({
  checkForDesktopUpdateStatus: mocks.checkForDesktopUpdateStatus,
  DESKTOP_UPDATE_AVAILABLE_EVENT: "sndbox:desktop-update-available"
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

const update = {
  version: "0.7.4-beta.3",
  releaseUrl: "https://github.com/sndboxhq/sandbox/releases/tag/v0.7.4-beta.3",
  installerUrl: "https://github.com/sndboxhq/sandbox/releases/download/v0.7.4-beta.3/sndbox_0.7.4-beta.3_x64-setup.exe",
  installerName: "sndbox_0.7.4-beta.3_x64-setup.exe"
};

describe("DesktopUpdateNotice", () => {
  beforeEach(() => {
    localStorage.clear();
    usePreferences.setState({ ...defaultPreferences });
    mocks.checkForDesktopUpdateStatus.mockResolvedValue({ status: "available", currentVersion: "0.7.4-beta.2", latestVersion: update.version, update });
    mocks.openUrl.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("names the available version and opens its installer download", async () => {
    render(<ToastProvider><DesktopUpdateNotice /></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Download sndbox v0.7.4-beta.3" }));

    await waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith(update.installerUrl));
    expect(await screen.findByText("Opening sndbox v0.7.4-beta.3 download in your browser.")).toBeVisible();
  });

  it("opens the release page and reports the fallback when the direct download fails", async () => {
    mocks.openUrl.mockRejectedValueOnce(new Error("blocked")).mockResolvedValueOnce(undefined);
    render(<ToastProvider><DesktopUpdateNotice /></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Download sndbox v0.7.4-beta.3" }));

    await waitFor(() => expect(mocks.openUrl).toHaveBeenNthCalledWith(2, update.releaseUrl));
    expect(await screen.findByRole("alert")).toHaveTextContent("opened the release page instead");
  });

  it("does not keep legacy permanent dismissals", async () => {
    localStorage.setItem("sandbox.dismissed-update.0.7.4-beta.3", "1");
    render(<ToastProvider><DesktopUpdateNotice /></ToastProvider>);

    expect(await screen.findByRole("button", { name: "Download sndbox v0.7.4-beta.3" })).toBeVisible();
  });
});
