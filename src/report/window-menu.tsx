// The window a tab looks at, as one button that names it ("Last 30 days", "Q3 2026") and opens a
// small panel: rolling windows, periods to date, and any calendar month, quarter or year the data
// reaches (decision D47). One control in the bar instead of a row of buttons and a menu.
import { useRef, useState } from "preact/hooks";
import { calendarChoices, type WindowKey, windowOf } from "../core/windows.ts";

const ROLLING: readonly { key: WindowKey; label: string }[] = [
  { key: "30d", label: "30 days" },
  { key: "60d", label: "60 days" },
  { key: "90d", label: "90 days" },
];

const TO_DATE: readonly { key: WindowKey; label: string }[] = [
  { key: "mtd", label: "Month" },
  { key: "qtd", label: "Quarter" },
  { key: "ytd", label: "Year" },
];

/** What the button says for a window. */
export function windowName(key: WindowKey, asOf: Date): string {
  const rolling = ROLLING.find((r) => r.key === key);
  if (rolling) return `Last ${rolling.label}`;
  const toDate = TO_DATE.find((t) => t.key === key);
  if (toDate) return `${toDate.label} to date`;
  return windowOf(key, asOf).current.label.replace(/ so far$/, "");
}

/** One window, chosen from the panel: it applies and the panel closes. */
export function WindowMenu(props: {
  value: WindowKey;
  /** The first day the data covers, and when it ends: which periods to offer. */
  from: string;
  asOf: Date;
  onChange: (key: WindowKey) => void;
}) {
  return (
    <WindowPanel
      id="window"
      label="Window"
      dialog="Choose a window"
      selected={[props.value]}
      text={windowName(props.value, props.asOf)}
      from={props.from}
      asOf={props.asOf}
      onPick={props.onChange}
    />
  );
}

/**
 * Several periods at once, such as two quarters (the PR list): each is ticked or unticked, the
 * panel stays open, and one is always left, so the list always has a time to cover.
 */
export function PeriodsMenu(props: {
  value: readonly WindowKey[];
  from: string;
  asOf: Date;
  onChange: (keys: WindowKey[]) => void;
}) {
  const names = props.value.map((key) => windowName(key, props.asOf));
  return (
    <WindowPanel
      id="periods"
      label="Periods"
      dialog="Choose periods"
      multi
      selected={props.value}
      text={names.length <= 2 ? names.join(" + ") : `${names.length} periods`}
      from={props.from}
      asOf={props.asOf}
      onPick={(key) => {
        if (!props.value.includes(key)) return props.onChange([...props.value, key]);
        if (props.value.length > 1) props.onChange(props.value.filter((k) => k !== key));
      }}
    />
  );
}

function WindowPanel(props: {
  id: string;
  label: string;
  dialog: string;
  multi?: boolean;
  selected: readonly WindowKey[];
  /** What the button says. */
  text: string;
  from: string;
  asOf: Date;
  onPick: (key: WindowKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const choose = (key: WindowKey) => {
    props.onPick(key);
    if (!props.multi) setOpen(false);
  };
  const { months, quarters, years } = calendarChoices(props.from, props.asOf);
  const item = (key: WindowKey, label: string) => (
    <button
      key={key}
      type="button"
      class="window-item"
      aria-pressed={props.selected.includes(key)}
      onClick={() => choose(key)}
    >
      {props.multi && props.selected.includes(key) ? "✓ " : ""}
      {label}
    </button>
  );
  return (
    // Escape is heard here, where focus is, from the moment the panel opens.
    // biome-ignore lint/a11y/noStaticElementInteractions: it only catches Escape from the button and panel inside
    <div
      class="control window-control"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <span class="visually-hidden" id={`${props.id}-label`}>
        {props.label}
      </span>
      <button
        ref={button}
        type="button"
        class="window-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={`${props.id}-label ${props.id}-name`}
        onClick={() => setOpen(!open)}
      >
        <span id={`${props.id}-name`}>{props.text}</span>
        <span aria-hidden="true" class="caret">
          ▾
        </span>
      </button>
      {open && (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a click outside closes it */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it too */}
          <div class="menu-shade" onClick={() => setOpen(false)} />
          <div class="menu window-menu" role="dialog" aria-label={props.dialog}>
            {props.multi && (
              <span class="window-hint">Choose one or more. Each is shown together.</span>
            )}
            <div class="window-row">
              <span class="menu-title">Last</span>
              <div class="window-items">{ROLLING.map((r) => item(r.key, r.label))}</div>
            </div>
            <div class="window-row">
              <span class="menu-title">To date</span>
              <div class="window-items">{TO_DATE.map((t) => item(t.key, t.label))}</div>
            </div>
            <div class="window-calendar">
              <div class="window-column">
                <span class="menu-title">Month</span>
                {months.map((m) => item(m.key, m.label.replace(/^(\w{3})\w* /, "$1 ")))}
              </div>
              <div class="window-column">
                <span class="menu-title">Quarter</span>
                {quarters.map((q) => item(q.key, q.label))}
              </div>
              <div class="window-column">
                <span class="menu-title">Year</span>
                {years.map((y) => item(y.key, y.label))}
              </div>
            </div>
            {props.multi && (
              <div class="window-done">
                <button type="button" class="button" onClick={() => setOpen(false)}>
                  Done
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
