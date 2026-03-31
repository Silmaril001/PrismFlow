import { HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
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

class NoopObjectStorageProvider implements ObjectStorageProvider {
  provider: "none" = "none";

  async uploadDataUrl(): Promise<UploadedObjectRef> {
    throw new Error("Object storage provider is disabled.");
  }

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

  async uploadDataUrl(input: { dataUrl: string; keyPrefix: string }): Promise<UploadedObjectRef> {
    const parsed = parseDataUrl(input.dataUrl);
    const datePrefix = new Date().toISOString().slice(0, 10);
    const key = `${trimSlashes(input.keyPrefix)}/${datePrefix}/${randomUUID()}.${parsed.extension}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: parsed.bytes,
        ContentType: parsed.contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );

    return {
      key,
      publicUrl: this.resolvePublicUrl(key),
      contentType: parsed.contentType,
      sizeBytes: parsed.bytes.length,
    };
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
