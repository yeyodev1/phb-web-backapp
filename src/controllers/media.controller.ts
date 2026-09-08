import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { Media } from "../models/Media";
import { uploadImage } from "../services/upload.service";

function publicBaseUrl(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
  return `${proto}://${host}`;
}

// POST /api/media  (admin)  body: { image: "data:image/...;base64,...", filename?: string }
export async function upload(req: Request, res: Response, next: NextFunction) {
  try {
    const { image, filename } = req.body as { image?: string; filename?: string };
    if (!image || typeof image !== "string") {
      res.status(400).json({ message: "image (data URI) is required" });
      return;
    }
    const result = await uploadImage(image, filename || "", publicBaseUrl(req));
    res.status(201).json({ data: result });
  } catch (error) {
    next(error);
  }
}

// GET /api/media/:id  (público, cacheable)
export async function serve(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      res.status(404).end();
      return;
    }
    const media = await Media.findById(id);
    if (!media) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", media.contentType);
    res.setHeader("Content-Length", String(media.size));
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(media.data);
  } catch (error) {
    next(error);
  }
}
