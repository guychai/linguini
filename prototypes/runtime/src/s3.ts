/**
 * Minimal S3 client (AWS Signature V4, path-style) for sandbox snapshots: enough for SeaweedFS,
 * MinIO-compatible stores and AWS S3. Bodies stream from/to files; credentials never appear in
 * errors or logs (errors carry the status, S3 error code and object key only).
 */
import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface S3Config {
  endpoint: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}
export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const sha256hex = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const hmac = (k: string | Buffer, v: string) => createHmac("sha256", k).update(v).digest();
const enc = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const unxml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
/** SigV4 headers for one request. Exported for tests (AWS documented example vectors). */
export function signV4(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  now?: Date;
}): Record<string, string> {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": input.payloadHash,
  };
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((h) => `${h}:${String(lower[h]).trim()}\n`).join("");
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a, x], [b, y]) => (a! < b! ? -1 : a! > b! ? 1 : x! < y! ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    input.method,
    input.url.pathname,
    query,
    canonicalHeaders,
    names.join(";"),
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  let key: Buffer = hmac(`AWS4${input.secretAccessKey}`, day);
  for (const part of [input.region, "s3", "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

export class S3Client {
  private readonly region: string;
  constructor(private readonly config: S3Config) {
    this.region = config.region ?? "us-east-1";
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket))
      throw new Error("s3: invalid bucket name");
  }
  private url(key?: string) {
    const base = this.config.endpoint.replace(/\/+$/, "");
    const path = key === undefined ? "" : `/${key.split("/").map(enc).join("/")}`;
    return new URL(`${base}/${this.config.bucket}${path}`);
  }
  private request(
    method: string,
    key: string | undefined,
    init: { headers?: Record<string, string>; body?: Readable | Buffer; payloadHash?: string } = {},
  ) {
    return this.requestUrl(method, this.url(key), init);
  }
  private async requestUrl(
    method: string,
    url: URL,
    init: { headers?: Record<string, string>; body?: Readable | Buffer; payloadHash?: string } = {},
  ) {
    const headers = signV4({
      method,
      url,
      headers: init.headers ?? {},
      payloadHash: init.payloadHash ?? sha256hex(""),
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      region: this.region,
    });
    delete headers.host;
    const res = await fetch(url, {
      method,
      headers,
      body: init.body as BodyInit | undefined,
      ...(init.body instanceof Readable ? { duplex: "half" } : {}),
    } as RequestInit);
    return res;
  }
  private async fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => "");
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP${res.status}`;
    throw new S3Error(res.status, code, `s3 ${what}: ${res.status} ${code}`);
  }
  /** Create the bucket if it does not exist yet. */
  async ensureBucket() {
    const head = await this.request("HEAD", undefined);
    if (head.ok) return;
    const res = await this.request("PUT", undefined);
    if (res.ok || res.status === 409) return void (await res.arrayBuffer());
    await this.fail(res, `create bucket ${this.config.bucket}`);
  }
  /** One PUT: the object becomes visible only once the whole body has arrived (atomic replace). */
  async putFile(key: string, path: string, meta: Record<string, string> = {}) {
    const { size } = await stat(path);
    const hash = createHash("sha256");
    await pipeline(createReadStream(path), hash);
    const digest = hash.digest("hex");
    const headers: Record<string, string> = {
      "content-length": String(size),
      "content-type": "application/octet-stream",
    };
    for (const [k, v] of Object.entries(meta)) headers[`x-amz-meta-${k}`] = v;
    const res = await this.request("PUT", key, {
      headers,
      body: createReadStream(path),
      payloadHash: digest,
    });
    if (!res.ok) await this.fail(res, `put ${key}`);
    await res.arrayBuffer();
    return { size, sha256: digest };
  }
  /** null when missing; otherwise the object's user metadata. */
  async head(key: string): Promise<{ size: number; meta: Record<string, string> } | null> {
    const res = await this.request("HEAD", key);
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, `head ${key}`);
    const meta: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k.startsWith("x-amz-meta-")) meta[k.slice(11)] = v;
    });
    return { size: Number(res.headers.get("content-length") ?? 0), meta };
  }
  /** Download to a file; false when missing. */
  async getFile(key: string, path: string): Promise<boolean> {
    const res = await this.request("GET", key);
    if (res.status === 404) return (await res.arrayBuffer(), false);
    if (!res.ok || !res.body) await this.fail(res, `get ${key}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path, { mode: 0o600 }));
    return true;
  }
  /** Keys under `prefix` (ListObjectsV2, every page). */
  async list(prefix: string): Promise<Array<{ key: string; lastModified: string }>> {
    const out: Array<{ key: string; lastModified: string }> = [];
    let token: string | undefined;
    do {
      const url = this.url();
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      if (token) url.searchParams.set("continuation-token", token);
      const res = await this.requestUrl("GET", url);
      if (!res.ok) await this.fail(res, `list ${prefix}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([^<]*)<\/Key>/.exec(m[1]!)?.[1];
        if (key)
          out.push({
            key: unxml(key),
            lastModified: /<LastModified>([^<]*)</.exec(m[1]!)?.[1] ?? "",
          });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? (/<NextContinuationToken>([^<]*)</.exec(xml)?.[1] ?? undefined)
        : undefined;
      if (token) token = unxml(token);
    } while (token);
    return out;
  }
  async delete(key: string) {
    const res = await this.request("DELETE", key);
    if (!res.ok && res.status !== 404) await this.fail(res, `delete ${key}`);
    await res.arrayBuffer();
  }
}
