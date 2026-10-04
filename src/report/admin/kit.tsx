// Building blocks shared by the Setup sections: a part of the config opened and saved with its
// version, a form, a list's header and table, and small helpers.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Meta } from "../../core/source.ts";
import type { AdminApi, ConfigPart, Opened, PartValue } from "./api.ts";
import { Problem } from "./fields.tsx";

export type SectionProps = { api: AdminApi; meta: Meta | null; onSaved: () => void };

/** One part of the config, opened with its version, and saved whole. */
export function usePart(api: AdminApi, part: ConfigPart, onSaved: () => void) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () =>
    api.open(part).then(
      (value) => setOpened(value),
      (err: unknown) => setProblem(message(err)),
    );
  useEffect(() => {
    reload();
  }, [part]);
  const save = async (value: PartValue): Promise<boolean> => {
    if (!opened) return false;
    setBusy(true);
    setProblem(null);
    try {
      await api.save(part, value, opened.version);
      await reload();
      onSaved();
      return true;
    } catch (err) {
      setProblem(message(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { opened, problem, busy, save, setProblem };
}

export function Head(props: { title: string; note: string; onAdd: () => void }) {
  return (
    <div class="card-head" style={{ padding: "0 2px" }}>
      <h2>{props.title}</h2>
      <span class="note">{props.note}</span>
      <span class="end">
        <button type="button" class="button" onClick={props.onAdd}>
          Add
        </button>
      </span>
    </div>
  );
}

export function Form(props: {
  title: string;
  problem: string | null;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
  children: ComponentChildren;
}) {
  return (
    <form
      class="card form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave();
      }}
    >
      <h2 style={{ fontSize: "14px" }} class="wide-field">
        {props.title}
      </h2>
      {props.children}
      <div class="wide-field">
        <Problem text={props.problem} />
        <div style={{ display: "flex", gap: "8px" }}>
          <button type="submit" class="button primary" disabled={props.busy}>
            {props.busy ? "Saving…" : "Save"}
          </button>
          <button type="button" class="button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}

export function Table(props: {
  cols: string;
  head: string[];
  empty: string;
  children: ComponentChildren[];
}) {
  return (
    <section class="card flush">
      <div class="table">
        <div class="table-inner" style={{ "--min": "760px" }}>
          <div class="row head" style={{ "--cols": props.cols }}>
            {props.head.map((h) => (
              <span key={h}>{h}</span>
            ))}
          </div>
          {props.children.length > 0 ? props.children : <div class="empty">{props.empty}</div>}
        </div>
      </div>
    </section>
  );
}

export function Actions(props: { onEdit: () => void; onRemove: () => void }) {
  return (
    <span style={{ display: "flex", gap: "12px" }}>
      <button type="button" class="link-button" onClick={props.onEdit}>
        Edit
      </button>
      <button type="button" class="link-button" onClick={props.onRemove}>
        Remove
      </button>
    </span>
  );
}

export function Waiting({ problem }: { problem: string | null }) {
  return problem ? <p class="problem">{problem}</p> : <p class="muted">Loading…</p>;
}

/** "teams Payments · labels chore": a rule's scope, conditions or effects in a line. */
export function summary(fields: Record<string, unknown> | undefined): string {
  return Object.entries(fields ?? {})
    .map(([key, value]) => {
      const shown = Array.isArray(value)
        ? value
            .map((v) =>
              typeof v === "object" && v
                ? `${(v as { bucket: string }).bucket}: ${String((v as { match: unknown }).match)}`
                : String(v),
            )
            .join(", ")
        : String(value);
      return `${key.replaceAll("_", " ")} ${shown}`;
    })
    .join(" · ");
}

/** The object without fields that say nothing: undefined, empty strings, empty lists. */
export function clean<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0),
    ),
  ) as T;
}

export function without<T>(map: Record<string, T>, key: string | null): Record<string, T> {
  const next = { ...map };
  if (key !== null) delete next[key];
  return next;
}

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
