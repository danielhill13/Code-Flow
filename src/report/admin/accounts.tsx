// Setup › People, the accounts behind them (decision D42): every GitHub and Azure DevOps account
// the org's PRs show, suggestions of which are one person, and merging them into one, in a click
// or by choosing them. Merges are written to people.yml like any other edit there.
import { useEffect, useState } from "preact/hooks";
import { num } from "../../core/format.ts";
import { mergePeople, type PersonRaw, separate } from "../../core/identities.ts";
import type { AdminApi, Identities } from "./api.ts";
import { Problem, Text } from "./fields.tsx";
import { message } from "./kit.tsx";

const HOST = { github: "GitHub", ado: "Azure DevOps" } as const;

export function Accounts(props: {
  api: AdminApi;
  people: Record<string, PersonRaw>;
  /** Saves people.yml's people; true when it was saved. */
  save: (people: Record<string, PersonRaw>) => Promise<boolean>;
  /** Bumped when people.yml changes, to read the accounts again. */
  version: string;
  /** Why the last save was refused, if it was. */
  saveProblem?: string | null;
  /** A save is under way: nothing else is saved until it's done, so none is made stale. */
  busy?: boolean;
}) {
  const [data, setData] = useState<Identities | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [loose, setLoose] = useState(true);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  useEffect(() => {
    props.api.identities().then(setData, (err: unknown) => setProblem(message(err)));
  }, [props.api, props.version]);
  if (problem) return <Problem text={problem} />;
  if (!data) return null;
  const refused = props.saveProblem ? <Problem text={props.saveProblem} /> : null;
  if (data.identities.length === 0) return null;

  const id = (i: { host: string; login: string }) => `${i.host}:${i.login}`;
  const nameOf = (login: string) =>
    data.identities.find((i) => i.login === login)?.name ?? undefined;
  const merge = async (request: {
    key: string;
    name?: string;
    github: string[];
    ado: string[];
  }) => {
    setProblem(null);
    if (await props.save(mergePeople(props.people, request))) {
      setChosen(new Set());
      setKey("");
      setName("");
    }
  };
  const suggestions = data.suggestions.filter((s) => !hidden.has(`${s.github}|${s.ado}`));
  const picked = data.identities.filter((i) => chosen.has(id(i)));
  const defaultKey =
    picked.find((i) => i.person)?.person ?? picked.find((i) => i.host === "github")?.login ?? "";
  const defaultName = picked.find((i) => i.name)?.name ?? "";
  const shown = data.identities.filter((i) => !loose || i.person === null || chosen.has(id(i)));
  // Accounts whose person has more than one account: those can be separated again.
  const shared = new Set(
    Object.entries(props.people)
      .filter(([k, p]) => [...(p.github ?? [k]), ...(p.ado ?? [])].length > 1)
      .map(([k]) => k),
  );
  const cols = "28px minmax(180px,1.4fr) 110px minmax(120px,1fr) 90px minmax(120px,1fr) 90px";
  return (
    <>
      {suggestions.length > 0 && (
        <section class="card vstack" aria-labelledby="same-person">
          <div class="card-head">
            <h2 id="same-person">Same person on GitHub and Azure DevOps?</h2>
            <span class="note">
              Merged, their PRs on both count as one person's, and their team's.
            </span>
          </div>
          {suggestions.map((s) => (
            <div key={`${s.github}|${s.ado}`} class="suggestion">
              <span>
                <b>{s.github}</b> <span class="muted">on GitHub</span> and <b>{s.ado}</b>{" "}
                <span class="muted">on Azure DevOps</span>
                {nameOf(s.ado) && <span class="muted"> ({nameOf(s.ado)})</span>}
              </span>
              <span class={`pill-${s.strength}`}>
                {s.strength === "strong" ? "Likely the same" : "Possibly the same"}: {s.reason}
                {s.ambiguous ? "; another account matches too" : ""}
              </span>
              <span class="step-actions">
                <button
                  type="button"
                  class="button"
                  disabled={props.busy}
                  onClick={() =>
                    merge({
                      key: s.person ?? s.github,
                      name: nameOf(s.ado),
                      github: [s.github],
                      ado: [s.ado],
                    })
                  }
                >
                  Merge
                </button>
                <button
                  type="button"
                  class="link-button"
                  onClick={() => setHidden(new Set([...hidden, `${s.github}|${s.ado}`]))}
                >
                  Not the same
                </button>
              </span>
            </div>
          ))}
        </section>
      )}

      {refused}
      <section class="card flush" aria-labelledby="accounts">
        <div class="card-head" style={{ padding: "0 20px 8px" }}>
          <h2 id="accounts">Accounts</h2>
          <span class="note">
            Every account in the PRs. Tick the ones that are one person, then merge them.
          </span>
          <label class="end radio">
            <input
              type="checkbox"
              checked={loose}
              onChange={(e) => setLoose(e.currentTarget.checked)}
            />
            Only accounts not in a person
          </label>
        </div>
        {picked.length > 0 && (
          <form
            class="merge-bar"
            onSubmit={(e) => {
              e.preventDefault();
              merge({
                key: key.trim() || defaultKey,
                name: name.trim() || defaultName || undefined,
                github: picked.filter((i) => i.host === "github").map((i) => i.login),
                ado: picked.filter((i) => i.host === "ado").map((i) => i.login),
              });
            }}
          >
            <span>
              {picked.length === 1 ? "1 account" : `${num(picked.length)} accounts`} chosen
            </span>
            <Text label="As person" value={key} onChange={setKey} placeholder={defaultKey} />
            <Text
              label="Name"
              value={name}
              onChange={setName}
              placeholder={defaultName || "their name"}
            />
            <button
              type="submit"
              class="button primary"
              disabled={props.busy || !(key.trim() || defaultKey)}
            >
              Merge into one person
            </button>
            <button type="button" class="link-button" onClick={() => setChosen(new Set())}>
              Clear
            </button>
          </form>
        )}
        <div class="table">
          <div class="table-inner" style={{ "--min": "760px" }}>
            <div class="row head" style={{ "--cols": cols }}>
              <span />
              <span>Account</span>
              <span>Host</span>
              <span>Name</span>
              <span>PRs</span>
              <span>Person</span>
              <span />
            </div>
            {shown.slice(0, 200).map((identity) => (
              <div key={id(identity)} class="row dense" style={{ "--cols": cols }}>
                <input
                  type="checkbox"
                  aria-label={`Choose ${identity.login}`}
                  checked={chosen.has(id(identity))}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.currentTarget.checked) next.add(id(identity));
                    else next.delete(id(identity));
                    setChosen(next);
                  }}
                />
                <span>{identity.login}</span>
                <span class="soft">{HOST[identity.host]}</span>
                <span class="soft">{identity.name ?? ""}</span>
                <span
                  class="num"
                  title={`${identity.authored} opened, ${identity.involved} taken part in`}
                >
                  {num(identity.authored)} / {num(identity.involved)}
                </span>
                <span class="soft">{identity.person ?? ""}</span>
                <span>
                  {identity.person && shared.has(identity.person) && (
                    <button
                      type="button"
                      class="link-button"
                      disabled={props.busy}
                      onClick={() => props.save(separate(props.people, identity.login))}
                    >
                      Separate
                    </button>
                  )}
                </span>
              </div>
            ))}
            {shown.length === 0 && <div class="empty">Every account is in a person.</div>}
          </div>
        </div>
        {shown.length > 200 && (
          <p class="muted" style={{ padding: "8px 20px" }}>
            The 200 most active of {num(shown.length)}.
          </p>
        )}
      </section>
    </>
  );
}
