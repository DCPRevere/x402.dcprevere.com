import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`missing required env: ${name}`);
  }
  return v;
}

function caip2(s: string): `${string}:${string}` {
  if (!/^[^:]+:[^:]+$/.test(s)) {
    throw new Error(`NETWORK must be CAIP-2 format like eip155:84532, got: ${s}`);
  }
  return s as `${string}:${string}`;
}

function ethAddress(s: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    throw new Error(`PAY_TO must be a 0x-prefixed 20-byte hex address, got: ${s}`);
  }
  if (/^0x0{40}$/.test(s)) {
    throw new Error("PAY_TO is the zero address — refusing to start (would silently misroute payments)");
  }
  return s as `0x${string}`;
}

export const config = {
  port: Number(process.env.PORT ?? 4021),
  network: caip2(required("NETWORK", "eip155:84532")),
  facilitatorUrl: required("FACILITATOR_URL", "https://x402.org/facilitator"),
  payTo: ethAddress(required("PAY_TO")),
  posthogKey: process.env.POSTHOG_KEY ?? "",
  posthogHost: process.env.POSTHOG_HOST ?? "https://eu.i.posthog.com",
};
