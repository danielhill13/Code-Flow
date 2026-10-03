import { render } from "preact";
import { EmbeddedSource, type ReportData } from "../core/source.ts";
import { App } from "./app.tsx";

/** The data `codeflow build` embedded, or, on the development server, the data it serves. */
async function load(): Promise<ReportData> {
  const embedded = document.getElementById("codeflow-data")?.textContent?.trim();
  if (embedded && embedded !== "null") return JSON.parse(embedded) as ReportData;
  const response = await fetch("./codeflow-data.json");
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as ReportData;
}

const root = document.getElementById("app");
if (root) {
  load().then(
    (data) => render(<App source={new EmbeddedSource(data)} />, root),
    (error: unknown) => {
      root.textContent = `This report has no data: ${error instanceof Error ? error.message : String(error)}`;
    },
  );
}
