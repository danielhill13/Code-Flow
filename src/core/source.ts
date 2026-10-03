import type { PrFact } from "./facts.ts";
import type { Groups } from "./groups.ts";
import { type Choices, choices } from "./selection.ts";
import { type CompareModel, type CompareQuery, compare } from "./views/compare.ts";
import type { ViewContext, ViewQuery } from "./views/context.ts";
import { type FlowModel, flow } from "./views/flow.ts";
import { type OverviewModel, overview } from "./views/overview.ts";
import { type PrListModel, type PrQuery, prDetail, prList } from "./views/prs.ts";
import { type ReviewModel, review } from "./views/review.ts";
import { type SpeedModel, speed } from "./views/speed.ts";

/** What `codeflow build` puts into a report: enough to compute every view in it. */
export type ReportData = {
  builtAt: string;
  /** When the data was last known complete. */
  asOf: string;
  /** The first day the data fully covers, YYYY-MM-DD: nothing before it is shown. */
  coveredFrom: string;
  repos: string[];
  /** Teams and products as config defines them, product repo patterns matched to repo names. */
  groups: Groups;
  facts: PrFact[];
};

export type Meta = Omit<ReportData, "facts" | "groups"> & { choices: Choices };

/**
 * Everything the report asks for, behind one interface. The static report answers from data
 * embedded in the page (EmbeddedSource); a hosted server will answer the same calls over HTTP.
 * Both run the same view builders in core/views, so they can't disagree.
 */
export interface DataSource {
  meta(): Promise<Meta>;
  overview(q: ViewQuery): Promise<OverviewModel>;
  speed(q: ViewQuery): Promise<SpeedModel>;
  review(q: ViewQuery): Promise<ReviewModel>;
  flow(q: ViewQuery): Promise<FlowModel>;
  compare(q: CompareQuery): Promise<CompareModel>;
  prs(q: PrQuery): Promise<PrListModel>;
  pr(id: string): Promise<PrFact | null>;
}

export class EmbeddedSource implements DataSource {
  readonly #meta: Meta;
  readonly #ctx: ViewContext;

  constructor(data: ReportData) {
    const { facts, groups, ...meta } = data;
    const options = choices(groups, data.repos, facts);
    this.#meta = { ...meta, choices: options };
    this.#ctx = {
      facts,
      choices: options,
      asOf: new Date(data.asOf),
      coveredFrom: data.coveredFrom,
    };
  }

  async meta(): Promise<Meta> {
    return this.#meta;
  }

  async overview(q: ViewQuery): Promise<OverviewModel> {
    return overview(this.#ctx, q);
  }

  async speed(q: ViewQuery): Promise<SpeedModel> {
    return speed(this.#ctx, q);
  }

  async review(q: ViewQuery): Promise<ReviewModel> {
    return review(this.#ctx, q);
  }

  async flow(q: ViewQuery): Promise<FlowModel> {
    return flow(this.#ctx, q);
  }

  async compare(q: CompareQuery): Promise<CompareModel> {
    return compare(this.#ctx, q);
  }

  async prs(q: PrQuery): Promise<PrListModel> {
    return prList(this.#ctx, q);
  }

  async pr(id: string): Promise<PrFact | null> {
    return prDetail(this.#ctx, id);
  }
}
