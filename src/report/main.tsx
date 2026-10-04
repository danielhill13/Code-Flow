import { render } from "preact";
import { HttpSource } from "../core/http-source.ts";
import { EmbeddedSource, type ReportData } from "../core/source.ts";
import { ServerAdmin, serverOrgs } from "./admin/api.ts";
import { App } from "./app.tsx";
import { Welcome } from "./welcome.tsx";

/** The data `codeflow build` embedded, or, on the development server, the data it serves. */
async function load(): Promise<ReportData> {
  const embedded = document.getElementById("codeflow-data")?.textContent?.trim();
  if (embedded && embedded !== "null") return JSON.parse(embedded) as ReportData;
  const response = await fetch("./codeflow-data.json");
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as ReportData;
}

/** The org this page is for, when `codeflow serve` serves it at /orgs/<org>/. */
const served = /^\/orgs\/([^/]+)\/?$/.exec(location.pathname)?.[1];

const root = document.getElementById("app");
if (root && location.pathname.replace(/\/$/, "") === "/welcome") {
  root.textContent = "";
  render(<Welcome />, root);
} else if (root && served) {
  const org = decodeURIComponent(served);
  serverOrgs().then(
    (orgs) => {
      root.textContent = "";
      render(
        <App
          source={new HttpSource(`/api/orgs/${encodeURIComponent(org)}`)}
          admin={new ServerAdmin(org)}
          orgs={orgs}
        />,
        root,
      );
    },
    (error: unknown) => {
      root.textContent = `codeflow serve didn't answer: ${error instanceof Error ? error.message : String(error)}`;
    },
  );
} else if (root) {
  load().then(
    (data) => {
      root.textContent = "";
      render(<App source={new EmbeddedSource(data)} />, root);
    },
    (error: unknown) => {
      root.textContent = `This report has no data: ${error instanceof Error ? error.message : String(error)}`;
    },
  );
}
