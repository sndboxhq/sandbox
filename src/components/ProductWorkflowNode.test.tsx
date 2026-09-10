import { ReactFlowProvider } from "@xyflow/react";
import { ProductWorkflowNode } from "@sandbox/product-ui";
import { render, screen } from "@testing-library/react";
import { Code2 } from "lucide-react";
import { describe, expect, it } from "vitest";

describe("ProductWorkflowNode named inputs", () => {
  it("renders three individually labelled Web Builder connectors", () => {
    render(
      <ReactFlowProvider>
        <ProductWorkflowNode
          id="site"
          name="Web Builder"
          summary="Serve on an available port"
          icon={Code2}
          inputCount={3}
          inputPorts={[
            { id: "html", label: "HTML" },
            { id: "javascript", label: "JS" },
            { id: "css", label: "CSS" },
          ]}
          outputLabels={["Localhost URL"]}
        />
      </ReactFlowProvider>,
    );

    expect(screen.getByLabelText("HTML input")).toBeInTheDocument();
    expect(screen.getByLabelText("JS input")).toBeInTheDocument();
    expect(screen.getByLabelText("CSS input")).toBeInTheDocument();
  });

  it("renders annotations without executable connection handles", () => {
    const { container } = render(
      <ReactFlowProvider>
        <ProductWorkflowNode
          id="setup"
          name="Before running"
          summary="Choose a connection"
          icon={Code2}
          inputCount={0}
          outputLabels={[]}
          standalone
          annotation
        />
      </ReactFlowProvider>,
    );

    expect(screen.getByLabelText("Canvas note; not executed")).toBeInTheDocument();
    expect(container.querySelector(".react-flow__handle")).not.toBeInTheDocument();
  });
});
