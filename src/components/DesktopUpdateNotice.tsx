import { Download, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { usePreferences } from "../preferences";
import { checkForDesktopUpdateStatus, DESKTOP_UPDATE_AVAILABLE_EVENT, type DesktopUpdate } from "../updates";
import { useToast } from "./ui/Toast";

const UPDATE_POLL_MS = 30 * 60 * 1_000;
const UPDATE_RETRY_MS = 60 * 1_000;
const DISMISSAL_MS = 24 * 60 * 60 * 1_000;

export function DesktopUpdateNotice({ collapsed = false }: { collapsed?: boolean }) {
  const { checkForUpdates, updateChannel } = usePreferences();
  const [update, setUpdate] = useState<DesktopUpdate>();
  const [opening, setOpening] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!checkForUpdates) { setUpdate(undefined); return; }
    let active = true;
    let retryTimer: number | undefined;
    const check = async () => {
      const result = await checkForDesktopUpdateStatus(updateChannel);
      if (!active) return;
      if (result.status === "available") {
        if (!dismissedRecently(result.update.version)) setUpdate(result.update);
      } else if (result.status === "current") {
        setUpdate(undefined);
      } else if (result.status === "error") {
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => void check(), UPDATE_RETRY_MS);
      }
    };
    const checkWhenVisible = () => { if (document.visibilityState === "visible") void check(); };
    const reveal = (event: Event) => {
      const available = (event as CustomEvent<DesktopUpdate>).detail;
      if (available?.version) setUpdate(available);
    };
    void check();
    const pollTimer = window.setInterval(() => void check(), UPDATE_POLL_MS);
    window.addEventListener("online", checkWhenVisible);
    document.addEventListener("visibilitychange", checkWhenVisible);
    window.addEventListener(DESKTOP_UPDATE_AVAILABLE_EVENT, reveal);
    return () => {
      active = false;
      window.clearInterval(pollTimer);
      window.clearTimeout(retryTimer);
      window.removeEventListener("online", checkWhenVisible);
      document.removeEventListener("visibilitychange", checkWhenVisible);
      window.removeEventListener(DESKTOP_UPDATE_AVAILABLE_EVENT, reveal);
    };
  }, [checkForUpdates, updateChannel]);

  if (!update) return null;
  const openUpdate = async () => {
    if (opening) return;
    setOpening(true);
    const target = update.installerUrl ?? update.releaseUrl;
    try {
      await openUrl(target);
      const versionLabel = formatVersionLabel(update.version);
      toast.push(update.installerUrl ? `Opening sndbox ${versionLabel} download in your browser.` : `Opening sndbox ${versionLabel} release details.`);
    } catch {
      if (target !== update.releaseUrl) {
        try {
          await openUrl(update.releaseUrl);
          toast.push("The installer link could not be opened, so sndbox opened the release page instead.", "error");
          return;
        } catch {
          // Report the actionable fallback below.
        }
      }
      toast.push("sndbox could not open the update. Visit sndbox.app/downloads in your browser.", "error");
    } finally {
      setOpening(false);
    }
  };
  const dismiss = () => {
    localStorage.setItem(dismissalKey(update.version), String(Date.now()));
    setUpdate(undefined);
  };

  const versionLabel = formatVersionLabel(update.version);
  const action = update.installerUrl ? `Download sndbox ${versionLabel}` : `View sndbox ${versionLabel}`;
  if (collapsed) return <button className="desktop-update-collapsed" title={action} aria-label={action} disabled={opening} onClick={() => void openUpdate()}><Download size={15}/></button>;
  return <aside className="desktop-update-notice" aria-live="polite">
    <button className="desktop-update-link" title={action} aria-label={action} disabled={opening} onClick={() => void openUpdate()}><Download size={14}/><span>{opening ? "Opening download…" : update.installerUrl ? `Download ${versionLabel}` : `View ${versionLabel}`}</span></button>
    <button className="desktop-update-dismiss" aria-label={`Dismiss sndbox ${versionLabel} update`} title="Dismiss" onClick={dismiss}><X size={13}/></button>
  </aside>;
}

function formatVersionLabel(version: string): string {
  return `v${version.replace(/^v/, "")}`;
}

function dismissalKey(version: string) {
  return `sandbox.dismissed-update.${version}`;
}

function dismissedRecently(version: string): boolean {
  const dismissedAt = Number(localStorage.getItem(dismissalKey(version)));
  return Number.isFinite(dismissedAt) && dismissedAt > 0 && Date.now() - dismissedAt < DISMISSAL_MS;
}
