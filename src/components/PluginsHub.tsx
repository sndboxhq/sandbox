import * as Tabs from "@radix-ui/react-tabs";
import { Blocks, Braces, Search } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import { LoadingSkeleton } from "./ui/States";

const MarketplaceView = lazy(() =>
  import("./MarketplaceView").then((module) => ({
    default: module.MarketplaceView,
  })),
);
const InstalledPluginsView = lazy(() =>
  import("./InstalledPluginsView").then((module) => ({
    default: module.InstalledPluginsView,
  })),
);
const PluginBuilderView = lazy(() =>
  import("./PluginBuilderView").then((module) => ({
    default: module.PluginBuilderView,
  })),
);

export function PluginsHub() {
  const [tab, setTab] = useState("discover");
  useEffect(() => {
    const showInstalled = () => setTab("installed");
    window.addEventListener("sandbox:plugins-installed", showInstalled);
    return () =>
      window.removeEventListener("sandbox:plugins-installed", showInstalled);
  }, []);
  return (
    <Tabs.Root className="plugins-hub" value={tab} onValueChange={setTab}>
      <div className="plugins-hub-tabs">
        <Tabs.List aria-label="Plugin sections">
          <Tabs.Trigger value="discover">
            <Search size={14} />
            Discover
          </Tabs.Trigger>
          <Tabs.Trigger value="installed">
            <Blocks size={14} />
            Installed
          </Tabs.Trigger>
          <Tabs.Trigger value="build">
            <Braces size={14} />
            Build
          </Tabs.Trigger>
        </Tabs.List>
      </div>
      <Suspense
        fallback={
          <main className="content">
            <LoadingSkeleton rows={6} />
          </main>
        }
      >
        <Tabs.Content value="discover">
          <MarketplaceView />
        </Tabs.Content>
        <Tabs.Content value="installed">
          <InstalledPluginsView />
        </Tabs.Content>
        <Tabs.Content value="build">
          <PluginBuilderView />
        </Tabs.Content>
      </Suspense>
    </Tabs.Root>
  );
}
