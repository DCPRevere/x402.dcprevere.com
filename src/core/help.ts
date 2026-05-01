import type { Express, Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { SUPPORTED_NETWORKS } from "./networks.js";
import { canonicalJson, etagFor } from "./json.js";

/**
 * Fractal /help system.
 *
 * Every node in the tree returns the same envelope. Internal nodes inline the
 * full descriptor of every node beneath them — calling /help returns the
 * complete catalog in one document. Calling /<slug>/help returns the same
 * subtree as it appears nested under root.
 *
 * Three access forms, all returning identical JSON:
 *   1. Path suffix:   GET /<path>/help
 *   2. Query flag:    GET /<path>?help
 *   3. HTTP verb:     OPTIONS /<path>
 *
 * Filters: ?depth=N truncates descent, ?since=<iso8601> drops untouched subtrees.
 * Etag is sha256 over canonical JSON; supports If-None-Match → 304.
 */

export const HELP_SCHEMA_VERSION = "2026-04-29";

// ----- Types ------------------------------------------------------------

export type Status = "live" | "beta" | "coming-soon";

export interface OperatorMeta {
  contact: string;
  status_page: string;
  tos: string;
}

export interface NetworkMeta {
  default: string;
  supported: string[];
}

export interface ParentRef {
  url: string;
  help_url: string;
}

interface NodeBase {
  name: string;
  url: string;
  description: string;
  tags: string[];
  status: Status;
  schema_version: string;
  last_modified: string;
  parent: ParentRef | null;
  operator: OperatorMeta;
  network: NetworkMeta;
}

export interface PricingFree {
  kind: "free";
}

export interface PricingFlat {
  kind: "flat";
  /** USDC base units (6 decimals), as a decimal string. */
  amount: string;
  /** Human-readable USDC amount, e.g. "0.10". */
  amount_usdc: string;
}

export interface ParametricRule {
  when: string;
  amount?: string;
  amount_usdc?: string;
  multiplier?: number;
  add?: string;
  add_usdc?: string;
  min_amount?: string;
  min_amount_usdc?: string;
}

export interface ParametricExample {
  call: string;
  amount: string;
  amount_usdc: string;
}

export interface PricingParametric {
  kind: "parametric";
  rules: ParametricRule[];
  examples: ParametricExample[];
}

export type Pricing = PricingFree | PricingFlat | PricingParametric;

export interface ParamSpec {
  name: string;
  type: string;
  required?: boolean;
  default?: string | number | boolean | null;
  values?: readonly string[];
  doc: string;
}

export interface InputSpec {
  params: ParamSpec[];
}

export interface OutputSpec {
  media_types: string[];
  schema_url?: string;
}

export interface EndpointExample {
  request: string;
  response?: string;
}

/**
 * Shape products supply at registration time. The registry enriches these
 * with operator metadata, network info, schema version, and absolute URLs at
 * resolve-time so descriptors stay terse and decoupled from deploy config.
 */
export interface EndpointHelpInput {
  name: string;
  description: string;
  tags: string[];
  status: Status;
  last_modified: string;
  input: InputSpec;
  pricing: Pricing;
  output: OutputSpec;
  examples: EndpointExample[];
  /** Slug appended to the product mountPath (e.g. "render"). */
  slug: string;
}

export interface ProductHelpInput {
  name: string;
  description: string;
  tags: string[];
  status: Status;
  last_modified: string;
  endpoints: EndpointHelpInput[];
}

export interface EndpointHelp extends NodeBase {
  level: "endpoint";
  input: InputSpec;
  pricing: Pricing;
  output: OutputSpec;
  examples: EndpointExample[];
}

export interface ProductHelp extends NodeBase {
  level: "product";
  children: EndpointHelp[];
}

export interface UmbrellaHelp extends NodeBase {
  level: "umbrella";
  children: (ProductHelp | EndpointHelp)[];
}

export type ResolvedHelp = UmbrellaHelp | ProductHelp | EndpointHelp;

export interface ResolveOptions {
  depth?: number;
  since?: Date;
}

// ----- Registry ---------------------------------------------------------

interface RegisteredProduct {
  input: ProductHelpInput;
  /** Path the product is mounted at, e.g. "/graphics/figlet". */
  mountPath: string;
}

class HelpRegistry {
  private products = new Map<string, RegisteredProduct>();
  private umbrellaName = "x402.aegent.dev";
  private umbrellaDescription =
    "Pay-per-call APIs for the agentic economy. Each product charges in USDC on Base via x402.";
  private umbrellaTags = ["umbrella", "x402"];

  /**
   * Derived at resolve time so the umbrella's last_modified reflects the
   * latest registered product. Without this, etag-based clients would never
   * invalidate after a deploy that only bumps a single product's
   * last_modified — the umbrella would still report its module-load time.
   */
  private get umbrellaLastModified(): string {
    let latest = "1970-01-01T00:00:00Z";
    for (const product of this.products.values()) {
      if (product.input.last_modified > latest) {
        latest = product.input.last_modified;
      }
    }
    return latest === "1970-01-01T00:00:00Z" ? new Date().toISOString() : latest;
  }

  /** Idempotent: re-registering the same mountPath replaces the prior input. */
  registerProduct(input: ProductHelpInput, mountPath: string): void {
    this.products.set(mountPath, { input, mountPath });
  }

  /** Used by tests to start fresh. */
  clear(): void {
    this.products.clear();
  }

  has(mountPath: string): boolean {
    return this.products.has(mountPath);
  }

  /**
   * Resolve a logical path to a fully-expanded help node.
   *
   *   "/" or ""       → umbrella
   *   "/graphics/figlet"          → product subtree
   *   "/graphics/figlet/render"   → endpoint leaf
   *
   * Returns null if no node matches.
   */
  resolve(path: string, opts: ResolveOptions = {}): ResolvedHelp | null {
    const normalized = normalizePath(path);

    if (normalized === "/" || normalized === "") {
      return this.buildUmbrella(opts);
    }

    // Match a product whose mountPath is a prefix of `normalized`.
    let matched: RegisteredProduct | null = null;
    for (const product of this.products.values()) {
      if (
        normalized === product.mountPath ||
        normalized.startsWith(product.mountPath + "/")
      ) {
        if (
          !matched ||
          product.mountPath.length > matched.mountPath.length
        ) {
          matched = product;
        }
      }
    }
    if (!matched) return null;

    const remainder = normalized.slice(matched.mountPath.length);
    if (remainder === "" || remainder === "/") {
      return this.buildProduct(matched, opts, this.umbrellaParent());
    }

    const endpointSlug = remainder.replace(/^\//, "");
    const endpoint = matched.input.endpoints.find((e) => e.slug === endpointSlug);
    if (!endpoint) return null;

    const productParent: ParentRef = {
      url: this.absoluteUrl(matched.mountPath),
      help_url: this.absoluteUrl(matched.mountPath + "/help"),
    };
    const built = this.buildEndpoint(endpoint, matched.mountPath, productParent);
    if (opts.since && !nodeOrDescendantsTouched(built, opts.since)) return null;
    return built;
  }

  /** Returns the full umbrella tree (with all subtrees inlined). */
  private buildUmbrella(opts: ResolveOptions): UmbrellaHelp {
    const umbrellaParent = null;
    const operatorMeta: OperatorMeta = {
      contact: config.operator.contact,
      status_page: config.operator.statusPage,
      tos: config.operator.tos,
    };
    const networkMeta: NetworkMeta = {
      default: config.network,
      supported: [...SUPPORTED_NETWORKS],
    };

    const childDepth = opts.depth === undefined ? undefined : Math.max(0, opts.depth - 1);
    const childOpts: ResolveOptions = { ...opts, depth: childDepth };

    const childProducts: ProductHelp[] = [];
    for (const product of this.products.values()) {
      const built = this.buildProduct(product, childOpts, {
        url: this.absoluteUrl("/"),
        help_url: this.absoluteUrl("/help"),
      });
      if (opts.since && !nodeOrDescendantsTouched(built, opts.since)) continue;
      childProducts.push(built);
    }
    childProducts.sort((a, b) => a.url.localeCompare(b.url));

    // /help registers itself as a free endpoint child of the umbrella.
    const helpSelf: EndpointHelp = {
      level: "endpoint",
      name: "help",
      url: this.absoluteUrl("/help"),
      description: "Live, machine-readable catalog of every product on this umbrella.",
      tags: ["meta", "discovery", "free"],
      status: "live",
      schema_version: HELP_SCHEMA_VERSION,
      last_modified: this.umbrellaLastModified,
      parent: { url: this.absoluteUrl("/"), help_url: this.absoluteUrl("/help") },
      operator: operatorMeta,
      network: networkMeta,
      input: {
        params: [
          {
            name: "depth",
            type: "int",
            required: false,
            doc: "Truncate descent at depth N; deeper subtrees become stubs.",
          },
          {
            name: "since",
            type: "iso8601",
            required: false,
            doc: "Drop subtrees whose every last_modified is older than the timestamp.",
          },
          {
            name: "help",
            type: "bool",
            required: false,
            doc: "Equivalent to appending /help to the path.",
          },
        ],
      },
      pricing: { kind: "free" },
      output: {
        media_types: ["application/json"],
      },
      examples: [
        { request: "GET /help" },
        { request: "GET /help?depth=1" },
        { request: "OPTIONS /graphics/figlet/render" },
      ],
    };

    const childCandidates: (ProductHelp | EndpointHelp)[] = [helpSelf, ...childProducts];
    const children = opts.since
      ? childCandidates.filter((c) => nodeOrDescendantsTouched(c, opts.since!))
      : childCandidates;

    return {
      level: "umbrella",
      name: this.umbrellaName,
      url: this.absoluteUrl("/"),
      description: this.umbrellaDescription,
      tags: this.umbrellaTags,
      status: "live",
      schema_version: HELP_SCHEMA_VERSION,
      last_modified: this.umbrellaLastModified,
      parent: umbrellaParent,
      operator: operatorMeta,
      network: networkMeta,
      children:
        opts.depth !== undefined && opts.depth <= 0
          ? []
          : children,
    };
  }

  private buildProduct(
    product: RegisteredProduct,
    opts: ResolveOptions,
    parent: ParentRef,
  ): ProductHelp {
    const operatorMeta: OperatorMeta = {
      contact: config.operator.contact,
      status_page: config.operator.statusPage,
      tos: config.operator.tos,
    };
    const networkMeta: NetworkMeta = {
      default: config.network,
      supported: [...SUPPORTED_NETWORKS],
    };

    const productParent: ParentRef = {
      url: this.absoluteUrl(product.mountPath),
      help_url: this.absoluteUrl(product.mountPath + "/help"),
    };

    const childDepth = opts.depth === undefined ? undefined : Math.max(0, opts.depth - 1);
    const childOpts: ResolveOptions = { ...opts, depth: childDepth };

    let endpoints: EndpointHelp[] = [];
    if (childOpts.depth === undefined || childOpts.depth > 0) {
      endpoints = product.input.endpoints
        .map((e) => this.buildEndpoint(e, product.mountPath, productParent))
        .filter((e) => !opts.since || nodeOrDescendantsTouched(e, opts.since));
    }

    return {
      level: "product",
      name: product.input.name,
      url: this.absoluteUrl(product.mountPath),
      description: product.input.description,
      tags: product.input.tags,
      status: product.input.status,
      schema_version: HELP_SCHEMA_VERSION,
      last_modified: product.input.last_modified,
      parent,
      operator: operatorMeta,
      network: networkMeta,
      children: endpoints,
    };
  }

  private buildEndpoint(
    endpoint: EndpointHelpInput,
    productMountPath: string,
    parent: ParentRef,
  ): EndpointHelp {
    const operatorMeta: OperatorMeta = {
      contact: config.operator.contact,
      status_page: config.operator.statusPage,
      tos: config.operator.tos,
    };
    const networkMeta: NetworkMeta = {
      default: config.network,
      supported: [...SUPPORTED_NETWORKS],
    };
    const url = this.absoluteUrl(productMountPath + "/" + endpoint.slug);
    return {
      level: "endpoint",
      name: endpoint.name,
      url,
      description: endpoint.description,
      tags: endpoint.tags,
      status: endpoint.status,
      schema_version: HELP_SCHEMA_VERSION,
      last_modified: endpoint.last_modified,
      parent,
      operator: operatorMeta,
      network: networkMeta,
      input: endpoint.input,
      pricing: endpoint.pricing,
      output: endpoint.output,
      examples: endpoint.examples,
    };
  }

  private umbrellaParent(): ParentRef {
    return {
      url: this.absoluteUrl("/"),
      help_url: this.absoluteUrl("/help"),
    };
  }

  private absoluteUrl(path: string): string {
    const base = config.publicBaseUrl.replace(/\/+$/, "");
    if (!base) return path === "" ? "/" : path;
    return path === "/" ? base + "/" : base + path;
  }
}

export const helpRegistry = new HelpRegistry();

// ----- Helpers ----------------------------------------------------------

function normalizePath(p: string): string {
  let s = p.trim();
  if (!s.startsWith("/")) s = "/" + s;
  // Strip trailing slashes except for root.
  s = s.replace(/\/+$/g, "");
  if (s === "") s = "/";
  return s;
}

function nodeOrDescendantsTouched(node: ResolvedHelp, since: Date): boolean {
  const own = Date.parse(node.last_modified);
  if (Number.isFinite(own) && own > since.getTime()) return true;
  if (node.level === "endpoint") return false;
  return node.children.some((c) => nodeOrDescendantsTouched(c, since));
}

// canonicalJson + etagFor moved to core/json.ts so /core/sign can depend on
// JSON canonicalisation without pulling in the entire help registry. Re-
// exported here for backward compatibility with the test suite.
export { canonicalJson, etagFor } from "./json.js";

// ----- Path classification ----------------------------------------------

interface ClassifiedRequest {
  /** True if this request asks for help (suffix, ?help, or OPTIONS). */
  isHelpRequest: boolean;
  /** The resource path to resolve in the registry. */
  resourcePath: string;
}

export function classifyHelpRequest(method: string, fullPath: string, hasHelpQuery: boolean): ClassifiedRequest {
  const path = normalizePath(fullPath);

  if (path === "/help") {
    return { isHelpRequest: true, resourcePath: "/" };
  }
  if (path.endsWith("/help") && path !== "/help") {
    return { isHelpRequest: true, resourcePath: path.slice(0, -"/help".length) || "/" };
  }
  if (hasHelpQuery) {
    return { isHelpRequest: true, resourcePath: path };
  }
  if (method === "OPTIONS") {
    return { isHelpRequest: true, resourcePath: path };
  }
  return { isHelpRequest: false, resourcePath: path };
}

// ----- Express integration ----------------------------------------------

function parseDepth(q: unknown): number | undefined {
  if (typeof q !== "string" || q === "") return undefined;
  const n = Number(q);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

function parseSince(q: unknown): Date | undefined {
  if (typeof q !== "string" || q === "") return undefined;
  const t = Date.parse(q);
  return Number.isFinite(t) ? new Date(t) : undefined;
}

export function helpMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Express decodes req.path without query string. `?help` lives in req.query.
  const hasHelpQuery = "help" in req.query;
  const classified = classifyHelpRequest(req.method, req.path, hasHelpQuery);
  if (!classified.isHelpRequest) return next();

  const opts: ResolveOptions = {
    depth: parseDepth(req.query.depth),
    since: parseSince(req.query.since),
  };
  const node = helpRegistry.resolve(classified.resourcePath, opts);
  if (!node) {
    res.status(404).type("application/json").send(
      JSON.stringify({ error: "no help node at path", path: classified.resourcePath }),
    );
    return;
  }

  const json = canonicalJson(node);
  const etag = etagFor(json);
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  res.setHeader("Allow", "GET, OPTIONS");

  const ifNoneMatch = req.header("if-none-match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    res.status(304).end();
    return;
  }

  res.status(200).type("application/json").send(json);
}

/** Mount /help and the catch-all helpMiddleware on the umbrella app. */
export function mountHelp(app: Express): void {
  // The middleware itself handles every path/method combination, including
  // /help, /<...>/help, ?help, and OPTIONS. Mount it before the paywall.
  app.use(helpMiddleware);
}
