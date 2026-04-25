import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { config } from "../config.js";

export interface UploadedObjectRef {
  key: string;
  publicUrl: string;
  contentType: string;
  sizeBytes: number;
}

export interface ObjectStorageHealth {
  ok: boolean;
  provider: "none" | "s3";
  detail?: string;
}

export interface ObjectStorageProvider {
  provider: "none" | "s3";
  uploadDataUrl(input: {
    dataUrl: string;
    keyPrefix: string;
  }): Promise<UploadedObjectRef>;
  uploadBase64(input: {
    base64: string;
    contentType: string;
    keyPrefix: string;
    fileName?: string;
  }): Promise<UploadedObjectRef>;
  readObjectAsBase64(input: { key: string }): Promise<{
    base64: string;
    contentType?: string;
    sizeBytes: number;
  }>;
  deleteObject(input: { key: string }): Promise<void>;
  healthCheck(): Promise<ObjectStorageHealth>;
}

interface ParsedDataUrl {
  contentType: string;
  bytes: Buffer;
  extension: string;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function inferFileExtension(contentType: string): string {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("svg")) return "svg";
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("quicktime")) return "mov";
  return "bin";
}

function parseDataUrl(dataUrl: string): ParsedDataUrl {
  const match = dataUrl.trim().match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    throw new Error("coverImageDataUrl must be a base64 data URL.");
  }
  const contentType = match[1] ?? "application/octet-stream";
  const bytes = Buffer.from(match[2] ?? "", "base64");
  if (bytes.length === 0) {
    throw new Error("coverImageDataUrl payload is empty.");
  }
  return {
    contentType,
    bytes,
    extension: inferFileExtension(contentType),
  };
}

function joinUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, "")}/${trimSlashes(key)}`;
}

function extensionWithoutDot(fileName?: string): string | undefined {
  if (!fileName) {
    return undefined;
  }
  const ext = extname(fileName).trim().toLowerCase();
  if (!ext) {
    return undefined;
  }
  return ext.replace(/^\./, "");
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (
    body &&
    typeof body === "object" &&
    "transformToByteArray" in body &&
    typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function"
  ) {
    const bytes = await (
      body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    return Buffer.from(bytes);
  }
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else {
        chunks.push(Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Unable to read object body from storage provider.");
}

class NoopObjectStorageProvider implements ObjectStorageProvider {
  provider: "none" = "none";

  async uploadDataUrl(): Promise<UploadedObjectRef> {
    throw new Error("Object storage provider is disabled.");
  }

  async uploadBase64(): Promise<UploadedObjectRef> {
    throw new Error("Object storage provider is disabled.");
  }

  async readObjectAsBase64(): Promise<{
    base64: string;
    contentType?: string;
    sizeBytes: number;
  }> {
    throw new Error("Object storage provider is disabled.");
  }

  async deleteObject(): Promise<void> {}

  async healthCheck(): Promise<ObjectStorageHealth> {
    return {
      ok: true,
      provider: "none",
      detail: "Object storage disabled; falling back to inline data URL.",
    };
  }
}

class S3ObjectStorageProvider implements ObjectStorageProvider {
  provider: "s3" = "s3";
  private client: S3Client;
  private bucket: string;
  private publicBaseUrl?: string;
  private endpoint?: string;

  constructor(params: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
    publicBaseUrl?: string;
  }) {
    this.bucket = params.bucket;
    this.publicBaseUrl = params.publicBaseUrl;
    this.endpoint = params.endpoint;

    this.client = new S3Client({
      region: params.region,
      endpoint: params.endpoint,
      forcePathStyle: params.forcePathStyle,
      credentials:
        params.accessKeyId && params.secretAccessKey
          ? {
              accessKeyId: params.accessKeyId,
              secretAccessKey: params.secretAccessKey,
            }
          : undefined,
    });
  }

  private resolvePublicUrl(key: string): string {
    if (this.publicBaseUrl) {
      return joinUrl(this.publicBaseUrl, key);
    }
    if (this.endpoint) {
      return joinUrl(`${this.endpoint.replace(/\/+$/, "")}/${this.bucket}`, key);
    }
    const region = config.s3Region === "auto" ? "us-east-1" : config.s3Region;
    return `https://${this.bucket}.s3.${region}.amazonaws.com/${trimSlashes(key)}`;
  }

  private buildObjectKey(params: {
    keyPrefix: string;
    contentType: string;
    fileName?: string;
  }): string {
    const datePrefix = new Date().toISOString().slice(0, 10);
    const ext = extensionWithoutDot(params.fileName) ?? inferFileExtension(params.contentType);
    const normalizedExt = ext.length > 0 ? ext : "bin";
    return `${trimSlashes(params.keyPrefix)}/${datePrefix}/${randomUUID()}.${normalizedExt}`;
  }

  private async uploadBytes(input: {
    bytes: Buffer;
    contentType: string;
    keyPrefix: string;
    fileName?: string;
    cacheControl?: string;
  }): Promise<UploadedObjectRef> {
    const key = this.buildObjectKey({
      keyPrefix: input.keyPrefix,
      contentType: input.contentType,
      fileName: input.fileName,
    });

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.bytes,
        ContentType: input.contentType,
        CacheControl: input.cacheControl,
      }),
    );

    return {
      key,
      publicUrl: this.resolvePublicUrl(key),
      contentType: input.contentType,
      sizeBytes: input.bytes.length,
    };
  }

  async uploadDataUrl(input: { dataUrl: string; keyPrefix: string }): Promise<UploadedObjectRef> {
    const parsed = parseDataUrl(input.dataUrl);
    return this.uploadBytes({
      bytes: parsed.bytes,
      contentType: parsed.contentType,
      keyPrefix: input.keyPrefix,
      fileName: `cover.${parsed.extension}`,
      cacheControl: "public, max-age=31536000, immutable",
    });
  }

  async uploadBase64(input: {
    base64: string;
    contentType: string;
    keyPrefix: string;
    fileName?: string;
  }): Promise<UploadedObjectRef> {
    const bytes = Buffer.from(input.base64, "base64");
    if (bytes.length === 0) {
      throw new Error("Object storage upload payload is empty.");
    }
    return this.uploadBytes({
      bytes,
      contentType: input.contentType,
      keyPrefix: input.keyPrefix,
      fileName: input.fileName,
      cacheControl: "private, max-age=0, no-cache",
    });
  }

  async readObjectAsBase64(input: { key: string }): Promise<{
    base64: string;
    contentType?: string;
    sizeBytes: number;
  }> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
      }),
    );
    if (!response.Body) {
      throw new Error(`Object not found or empty body: ${input.key}`);
    }
    const bytes = await bodyToBuffer(response.Body);
    return {
      base64: bytes.toString("base64"),
      contentType: response.ContentType ?? undefined,
      sizeBytes: bytes.length,
    };
  }

  async deleteObject(input: { key: string }): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
      }),
    );
  }

  async healthCheck(): Promise<ObjectStorageHealth> {
    try {
      await this.client.send(
        new HeadBucketCommand({
          Bucket: this.bucket,
        }),
      );
      return {
        ok: true,
        provider: "s3",
        detail: `Connected to bucket ${this.bucket}.`,
      };
    } catch (error) {
      return {
        ok: false,
        provider: "s3",
        detail: error instanceof Error ? error.message : "S3 health check failed.",
      };
    }
  }
}

export function createObjectStorageProviderFromConfig(): ObjectStorageProvider {
  if (config.objectStorageProvider !== "s3") {
    return new NoopObjectStorageProvider();
  }

  if (!config.s3Bucket) {
    throw new Error("OBJECT_STORAGE_PROVIDER=s3 requires S3_BUCKET.");
  }

  return new S3ObjectStorageProvider({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    bucket: config.s3Bucket,
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
    forcePathStyle: config.s3ForcePathStyle,
    publicBaseUrl: config.s3PublicBaseUrl,
  });
}
