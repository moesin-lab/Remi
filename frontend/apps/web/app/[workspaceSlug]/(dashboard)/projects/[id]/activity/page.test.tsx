import { Suspense } from "react";
import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { paths } from "@multiremi/core/paths";
import Page from "./page";

vi.mock("@multiremi/views/projects/components", () => ({ ProjectActivityPage: ({ projectId }: { projectId: string }) => <h1>{projectId}</h1> }));

it("opens the standalone activity route with the decoded project ID", async () => {
  expect(paths.workspace("space").projectActivity("p/1")).toBe("/space/projects/p%2F1/activity");
  const params = Promise.resolve({ workspaceSlug: "space", id: "p/1" });
  await act(async () => { render(<Suspense><Page params={params} /></Suspense>); await params; });
  expect(screen.getByRole("heading")).toHaveTextContent("p/1");
});
