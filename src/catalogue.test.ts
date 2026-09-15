import { describe, expect, it } from "vitest";
import { createNode, createPluginNode, definitionFor, enabledPluginNodes, NODE_DEFINITIONS } from "./catalogue";
import type { InstalledPlugin } from "./types";
import nodeContractSnapshot from "./generated/node-contracts.json";

describe("stage two node catalogue", () => {
  it("corresponds one-to-one with the generated engine contract snapshot", () => {
    expect(NODE_DEFINITIONS.map((definition) => definition.type).sort()).toEqual(
      nodeContractSnapshot.map((contract) => contract.nodeType).sort(),
    );
  });
  it("provides a standalone note for canvas instructions", () => {
    const note = createNode("note", { x: 40, y: 80 });
    expect(note).toMatchObject({
      type: "note",
      configuration: { content: expect.any(String) },
    });
    expect(definitionFor("note")).toMatchObject({
      group: "Notes",
      inputs: [],
      outputs: [],
      sideEffect: false,
    });
  });

  it("ships every collection node with stable routing defaults", () => {
    const types = new Set(NODE_DEFINITIONS.map(definition => definition.type));
    for (const type of ["filter", "switch", "loop_over_items", "split_out", "aggregate", "merge", "remove_duplicates"] as const) {
      expect(types.has(type)).toBe(true);
      expect(definitionFor(type).placements).toEqual(expect.arrayContaining(["local", "paired_runner", "hosted_runner"]));
    }
    const first=createNode("switch",{x:0,y:0});
    const second=createNode("switch",{x:0,y:0});
    expect(first.configuration.cases).toEqual(expect.arrayContaining([expect.objectContaining({id:"case_1"})]));
    (first.configuration.cases as Array<{name:string}>)[0].name="Renamed";
    expect((second.configuration.cases as Array<{name:string}>)[0].name).toBe("Case 1");
    expect(createNode("merge",{x:0,y:0}).configuration.inputPorts).toEqual([
      expect.objectContaining({id:"input_a"}),
      expect.objectContaining({id:"input_b"}),
    ]);
  });

  it("ships no-code power data nodes with typed ports and runnable defaults", () => {
    for (const type of ["map_fields", "validate_schema", "text_template", "hash_data"] as const) {
      const definition = definitionFor(type);
      expect(definition.group === "Data" || definition.group === "Logic").toBe(true);
      expect(definition.inputs.length).toBeGreaterThan(0);
      expect(definition.outputs.length).toBeGreaterThan(0);
      expect(definition.sideEffect).toBe(false);
      expect(createNode(type, { x: 0, y: 0 }).configuration).toEqual(expect.any(Object));
    }
  });

  it("exposes the complete managed Chromium action set", () => {
    const types = new Set(NODE_DEFINITIONS.map(definition => definition.type));
    for (const type of ["open_browser", "navigate", "click_element", "fill_field", "select_option", "press_key", "wait_for", "extract_data", "screenshot", "download_file", "upload_file", "close_browser"] as const) {
      expect(types.has(type)).toBe(true);
    }
  });

  it("stores only credential references in communication nodes", () => {
    for (const type of ["gmail_new_email_trigger", "gmail_create_draft", "gmail_send_email", "discord_webhook", "discord_embed", "slack_webhook"] as const) {
      const defaults = definitionFor(type).defaults;
      expect(defaults).toHaveProperty("credentialId", "");
      expect(JSON.stringify(defaults).toLowerCase()).not.toContain("webhookurl");
      expect(JSON.stringify(defaults).toLowerCase()).not.toContain("accesstoken");
    }
  });

  it("creates independent editable configuration objects", () => {
    const first = createNode("http_request", { x: 0, y: 0 });
    const second = createNode("http_request", { x: 20, y: 20 });
    (first.configuration.headers as Record<string, string>).Authorization = "secret";
    expect(second.configuration.headers).toEqual({});
  });

  it("creates exact pinned nodes only from enabled plugin versions", () => {
    const plugin={pluginId:"com.example.weather",version:"1.2.3",packageIntegrity:`sha256:${"a".repeat(64)}`,publisherId:"com.example",state:"enabled",manifest:{name:"Weather",nodes:[{nodeType:"weather.current",nodeVersion:2,displayName:"Current weather",description:"Read weather",category:"Data",riskLevel:"low",configurationSchema:{type:"object",properties:{units:{type:"string",default:"celsius"}}}}]}} as unknown as InstalledPlugin;
    const choices=enabledPluginNodes([plugin,{...plugin,state:"disabled"}]);
    expect(choices).toHaveLength(1);
    const node=createPluginNode(choices[0],{x:10,y:20});
    expect(node).toMatchObject({type:"weather.current",version:2,configuration:{units:"celsius"},plugin:{pluginId:"com.example.weather",pluginVersion:"1.2.3",packageIntegrity:plugin.packageIntegrity,publisherId:"com.example"}});
    expect(definitionFor(node.type).group).toBe("Plugins");
  });
});
