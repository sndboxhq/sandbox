import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginBuilderView } from "./PluginBuilderView";
import { ToastProvider } from "./ui/Toast";

const mocks = vi.hoisted(() => ({ createPluginProject: vi.fn() }));
vi.mock("../api", () => ({ api: { createPluginProject: mocks.createPluginProject } }));

describe("PluginBuilderView", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    mocks.createPluginProject.mockResolvedValue("C:\\plugins\\my-plugin");
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    vi.clearAllMocks();
  });

  it("creates the SDK-backed starter with the configured manifest", async () => {
    render(<ToastProvider><PluginBuilderView /></ToastProvider>);
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Weather Tools" } });
    fireEvent.change(screen.getByLabelText(/Plugin ID/), { target: { value: "uk.sndbox.weather" } });
    fireEvent.change(screen.getByLabelText(/Publisher ID/), { target: { value: "uk.sndbox" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose folder & create" }));

    await waitFor(() => expect(mocks.createPluginProject).toHaveBeenCalledTimes(1));
    const [folder, files] = mocks.createPluginProject.mock.calls[0];
    const manifest = JSON.parse(files.find((file: { path: string }) => file.path === "manifest.json").contents);
    expect(folder).toBe("my-plugin");
    expect(manifest).toMatchObject({ name: "Weather Tools", pluginId: "uk.sndbox.weather", publisherId: "uk.sndbox", minimumHostVersion: ">=0.8.0" });
    expect(await screen.findByText("Starter created")).toBeVisible();
  });

  it("does not create an invalid reverse-domain manifest", () => {
    render(<ToastProvider><PluginBuilderView /></ToastProvider>);
    fireEvent.change(screen.getByLabelText(/Plugin ID/), { target: { value: "INVALID" } });
    expect(screen.getByRole("button", { name: "Choose folder & create" })).toBeDisabled();
  });
});
