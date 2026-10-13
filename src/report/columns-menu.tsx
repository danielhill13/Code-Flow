// "Columns ▾": which columns a table shows, as a panel of checkboxes. Written for the PR list, and
// free of it, so another table can use it. The reader's choice goes in the link, so a shared link
// shows the same columns.
import { useRef, useState } from "preact/hooks";

export type ColumnChoice<K extends string> = {
  key: K;
  label: string;
  /** Always shown: a row without it would have no identity. */
  locked?: boolean;
};

export function ColumnsMenu<K extends string>(props: {
  options: readonly ColumnChoice<K>[];
  /** The columns shown now. */
  shown: readonly K[];
  /** Whether what's shown is the set's own default: "Reset" does nothing then. */
  isDefault: boolean;
  onChange: (shown: K[]) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const toggle = (key: K) =>
    props.onChange(
      props.shown.includes(key) ? props.shown.filter((k) => k !== key) : [...props.shown, key],
    );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only catches Escape from the button and panel inside
    <div
      class="columns-control"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        class="button columns-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Columns <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a click outside closes it */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it too */}
          <div class="menu-shade" onClick={() => setOpen(false)} />
          <div class="menu columns-menu" role="dialog" aria-label="Choose columns">
            <span class="menu-title">Show columns</span>
            <div class="columns-list">
              {props.options.map((option) => (
                <label key={option.key} class="columns-option">
                  <input
                    type="checkbox"
                    checked={option.locked || props.shown.includes(option.key)}
                    disabled={option.locked}
                    onChange={() => toggle(option.key)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
            <div class="columns-foot">
              <button
                type="button"
                class="link-button"
                disabled={props.isDefault}
                onClick={props.onReset}
              >
                Reset to default
              </button>
              <button type="button" class="button" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
