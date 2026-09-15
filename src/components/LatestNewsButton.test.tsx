import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LatestNewsButton, LATEST_NEWS_URL } from "./LatestNewsButton";
import { ToastProvider } from "./ui/Toast";

const mocks = vi.hoisted(() => ({ openUrl: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

describe("LatestNewsButton", () => {
  beforeEach(() => {
    mocks.openUrl.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens the sndbox news page", async () => {
    render(
      <ToastProvider>
        <LatestNewsButton />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Latest News" }));

    await waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith(LATEST_NEWS_URL));
  });

  it("keeps the destination available when the browser cannot be opened", async () => {
    mocks.openUrl.mockRejectedValue(new Error("blocked"));
    render(
      <ToastProvider>
        <LatestNewsButton collapsed />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Latest News" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("sndbox.app/news");
  });
});
