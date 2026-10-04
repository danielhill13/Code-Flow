// Form fields for the Setup tab. Each edits one plain value and reports it whole; lists are
// typed as text, comma- or line-separated, so pasting from a spreadsheet works.
import type { ComponentChildren } from "preact";

/** A labelled control. The hint sits outside the label, so the control's name is just its label. */
export function Field(props: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <div class="field">
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is the child passed in */}
      <label class="field-control">
        <span class="field-label">{props.label}</span>
        {props.children}
      </label>
      {props.hint && <span class="field-hint">{props.hint}</span>}
    </div>
  );
}

export function Text(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  list?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={props.label} hint={props.hint}>
      <input
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        list={props.list}
        disabled={props.disabled}
        onInput={(e) => props.onChange(e.currentTarget.value)}
      />
    </Field>
  );
}

/** A list typed as text: "a, b, c", or one per line with `lines`. */
export function List(props: {
  label: string;
  value: readonly string[];
  onChange: (value: string[]) => void;
  hint?: string;
  placeholder?: string;
  lines?: boolean;
}) {
  const text = props.value.join(props.lines ? "\n" : ", ");
  const parse = (raw: string) =>
    raw
      .split(props.lines ? /\n/ : /[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v !== "");
  return (
    <Field label={props.label} hint={props.hint}>
      {props.lines ? (
        <textarea
          rows={3}
          value={text}
          placeholder={props.placeholder}
          onChange={(e) => props.onChange(parse(e.currentTarget.value))}
        />
      ) : (
        <input
          type="text"
          value={text}
          placeholder={props.placeholder}
          onChange={(e) => props.onChange(parse(e.currentTarget.value))}
        />
      )}
    </Field>
  );
}

/** Yes, no, or unset: unset leaves the decision to whatever comes next (GitHub, a broader rule). */
export function Choice(props: {
  label: string;
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
  unset: string;
  yes: string;
  no: string;
  hint?: string;
}) {
  const value = props.value === undefined ? "" : props.value ? "yes" : "no";
  return (
    <Field label={props.label} hint={props.hint}>
      <select
        value={value}
        onChange={(e) => {
          const next = e.currentTarget.value;
          props.onChange(next === "" ? undefined : next === "yes");
        }}
      >
        <option value="">{props.unset}</option>
        <option value="yes">{props.yes}</option>
        <option value="no">{props.no}</option>
      </select>
    </Field>
  );
}

/** Several names to tick from a known list. */
export function Ticks(props: {
  label: string;
  options: readonly string[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  hint?: string;
}) {
  if (props.options.length === 0) return null;
  return (
    <fieldset class="field ticks">
      <legend class="field-label">{props.label}</legend>
      <div class="tick-list">
        {props.options.map((option) => (
          <label key={option}>
            <input
              type="checkbox"
              checked={props.value.includes(option)}
              onChange={() =>
                props.onChange(
                  props.value.includes(option)
                    ? props.value.filter((v) => v !== option)
                    : [...props.value, option],
                )
              }
            />
            {option}
          </label>
        ))}
      </div>
      {props.hint && <span class="field-hint">{props.hint}</span>}
    </fieldset>
  );
}

/** A message from the server, or about the form, above its buttons. */
export function Problem(props: { text: string | null }) {
  if (!props.text) return null;
  return (
    <p class="problem" role="alert">
      {props.text}
    </p>
  );
}
