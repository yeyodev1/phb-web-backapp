import crypto from "crypto";
import { Media } from "../models/Media";

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB (límite de body en Vercel ~4.5 MB)
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export interface UploadResult {
  url: string;
  provider: "cloudinary" | "mongo";
}

function parseDataUri(dataUri: string): { contentType: string; buffer: Buffer } {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUri);
  if (!match) throw Object.assign(new Error("Invalid image data"), { status: 400 });
  const contentType = match[1].toLowerCase();
  if (!ALLOWED.has(contentType)) {
    throw Object.assign(new Error("Unsupported image type. Use JPG, PNG, WEBP or GIF"), { status: 400 });
  }
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error("Image too large (max 4 MB)"), { status: 413 });
  }
  return { contentType, buffer };
}

// CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
function cloudinaryConfig() {
  const raw = process.env.CLOUDINARY_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "cloudinary:") return null;
    return { apiKey: u.username, apiSecret: u.password, cloudName: u.hostname };
  } catch {
    return null;
  }
}

async function uploadToCloudinary(dataUri: string, folder: string): Promise<string> {
  const cfg = cloudinaryConfig()!;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const toSign = `folder=${folder}&timestamp=${timestamp}${cfg.apiSecret}`;
  const signature = crypto.createHash("sha1").update(toSign).digest("hex");

  const form = new FormData();
  form.append("file", dataUri);
  form.append("api_key", cfg.apiKey);
  form.append("timestamp", timestamp);
  form.append("folder", folder);
  form.append("signature", signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`, {
    method: "POST",
    body: form,
  });
  const json = (await res.json()) as { secure_url?: string; error?: { message: string } };
  if (!res.ok || !json.secure_url) {
    throw Object.assign(new Error(json.error?.message || "Cloudinary upload failed"), { status: 502 });
  }
  return json.secure_url;
}

export async function uploadImage(
  dataUri: string,
  filename: string,
  publicBaseUrl: string
): Promise<UploadResult> {
  const { contentType, buffer } = parseDataUri(dataUri);

  if (cloudinaryConfig()) {
    const url = await uploadToCloudinary(dataUri, "phb-articles");
    return { url, provider: "cloudinary" };
  }

  const media = await Media.create({ filename, contentType, size: buffer.length, data: buffer });
  return { url: `${publicBaseUrl}/api/media/${media.id}`, provider: "mongo" };
}
