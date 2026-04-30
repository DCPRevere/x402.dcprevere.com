/**
 * Real verifiers for /passport/bind anchors. Replace the no-op default that
 * silently issued unverified bindings (review item #17).
 *
 *   ens     — resolve ENS name → address via viem; require match.
 *   domain  — HTTPS HEAD https://{domain}/.well-known/x402-passport
 *             expecting a body containing the wallet address.
 *   gist    — fetch the gist URL and search the body for the wallet.
 *
 * Each verifier short-circuits with `verified: false` on any error rather
 * than throwing, so the binding is still recorded (signed with verified=0).
 * The detail string explains what was checked and why it failed.
 */

import { getChainClient } from "../../core/chain.js";
import { normalize } from "viem/ens";

export interface VerifyResult {
  verified: boolean;
  detail: string;
}

export type AnchorKind = "ens" | "domain" | "gist";

const FETCH_TIMEOUT_MS = 5_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "x402.dcprevere.com/passport-verifier" },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyEns(wallet: string, name: string): Promise<VerifyResult> {
  let normalised: string;
  try {
    normalised = normalize(name);
  } catch (err) {
    return {
      verified: false,
      detail: `not a valid ENS name: ${err instanceof Error ? err.message : "normalise failed"}`,
    };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = getChainClient() as any;
    const resolved: string | null = await client.getEnsAddress({ name: normalised });
    if (!resolved) {
      return { verified: false, detail: `ENS ${normalised} resolved to no address` };
    }
    if (resolved.toLowerCase() === wallet.toLowerCase()) {
      return { verified: true, detail: `ENS ${normalised} resolves to ${wallet.toLowerCase()}` };
    }
    return {
      verified: false,
      detail: `ENS ${normalised} resolves to ${resolved.toLowerCase()}, not ${wallet.toLowerCase()}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ENS lookup failed";
    return { verified: false, detail: `ENS lookup error: ${msg}` };
  }
}

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export async function verifyDomain(wallet: string, host: string): Promise<VerifyResult> {
  if (!HOSTNAME_RE.test(host)) {
    return { verified: false, detail: `not a valid hostname: ${host}` };
  }
  const url = `https://${host}/.well-known/x402-passport`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      return { verified: false, detail: `${url} → HTTP ${res.status}` };
    }
    const body = await res.text();
    if (body.toLowerCase().includes(wallet.toLowerCase())) {
      return { verified: true, detail: `${url} contains ${wallet.toLowerCase()}` };
    }
    return { verified: false, detail: `${url} did not contain ${wallet.toLowerCase()}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetch failed";
    return { verified: false, detail: `domain verify error: ${msg}` };
  }
}

const GIST_RAW_RE = /^https:\/\/gist\.githubusercontent\.com\/[^/]+\/[0-9a-f]+\/raw(\/.*)?$/i;
const GIST_HTML_RE = /^https:\/\/gist\.github\.com\/[^/]+\/[0-9a-f]+(\/.*)?$/i;

export async function verifyGist(wallet: string, urlInput: string): Promise<VerifyResult> {
  // Accept either the html or the raw URL; normalise html → raw form.
  let url = urlInput;
  if (GIST_HTML_RE.test(urlInput) && !GIST_RAW_RE.test(urlInput)) {
    url = urlInput.replace("gist.github.com", "gist.githubusercontent.com") + "/raw";
  }
  if (!GIST_RAW_RE.test(url) && !GIST_HTML_RE.test(url)) {
    return { verified: false, detail: `not a recognisable gist URL: ${urlInput}` };
  }
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      return { verified: false, detail: `${url} → HTTP ${res.status}` };
    }
    const body = await res.text();
    if (body.toLowerCase().includes(wallet.toLowerCase())) {
      return { verified: true, detail: `${url} contains ${wallet.toLowerCase()}` };
    }
    return { verified: false, detail: `${url} did not contain ${wallet.toLowerCase()}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetch failed";
    return { verified: false, detail: `gist verify error: ${msg}` };
  }
}

export async function defaultVerifier(
  wallet: string,
  kind: AnchorKind,
  value: string,
): Promise<VerifyResult> {
  if (kind === "ens") return verifyEns(wallet, value);
  if (kind === "domain") return verifyDomain(wallet, value);
  return verifyGist(wallet, value);
}
