import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { Article } from "../models/Article";
import { slugify } from "../utils/slugify";

const SOURCES = ["drjuangarza", "phb"];

function pickFields(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const allowed = [
    "title", "slug", "excerpt", "content", "date", "featuredImage",
    "sourceUrl", "source", "categories", "tags", "isPublished",
  ];
  for (const key of allowed) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  if (out.source !== undefined && !SOURCES.includes(String(out.source))) {
    throw Object.assign(new Error(`source must be one of: ${SOURCES.join(", ")}`), { status: 400 });
  }
  if (out.date !== undefined) {
    const d = new Date(String(out.date));
    if (Number.isNaN(d.getTime())) throw Object.assign(new Error("Invalid date"), { status: 400 });
    out.date = d;
  }
  if (typeof out.slug === "string") out.slug = slugify(out.slug);
  return out;
}

async function uniqueSlug(base: string, excludeId?: string): Promise<string> {
  let slug = base || `articulo-${Date.now()}`;
  let i = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query: Record<string, unknown> = { slug };
    if (excludeId) query._id = { $ne: excludeId };
    const exists = await Article.exists(query);
    if (!exists) return slug;
    slug = `${base}-${i++}`;
  }
}

// GET /api/articles/admin  (admin) — incluye borradores y todas las fuentes
export async function adminList(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
    const skip = (page - 1) * limit;
    const search = ((req.query.search as string) || "").trim();
    const source = (req.query.source as string) || "";
    const status = (req.query.status as string) || ""; // published | draft

    const query: Record<string, unknown> = {};
    if (source && SOURCES.includes(source)) query.source = source;
    if (status === "published") query.isPublished = true;
    if (status === "draft") query.isPublished = false;
    if (search) query.title = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };

    const [articles, total] = await Promise.all([
      Article.find(query).sort({ date: -1 }).skip(skip).limit(limit).select("-content -__v"),
      Article.countDocuments(query),
    ]);

    res.json({ data: articles, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    next(error);
  }
}

// GET /api/articles/admin/:id  (admin)
export async function adminGet(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      res.status(404).json({ message: "Article not found" });
      return;
    }
    const article = await Article.findById(id).select("-__v");
    if (!article) {
      res.status(404).json({ message: "Article not found" });
      return;
    }
    res.json({ data: article });
  } catch (error) {
    next(error);
  }
}

// POST /api/articles  (admin)
export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const fields = pickFields(req.body || {});
    if (!fields.title || !String(fields.title).trim()) {
      res.status(400).json({ message: "title is required" });
      return;
    }
    const base = slugify(String(fields.slug || fields.title));
    fields.slug = await uniqueSlug(base);
    if (!fields.date) fields.date = new Date();
    if (!fields.source) fields.source = "drjuangarza";
    if (fields.isPublished === undefined) fields.isPublished = true;

    const article = await Article.create(fields);
    res.status(201).json({ data: article });
  } catch (error) {
    next(error);
  }
}

// PUT /api/articles/:id  (admin)
export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      res.status(404).json({ message: "Article not found" });
      return;
    }
    const fields = pickFields(req.body || {});
    if (fields.title !== undefined && !String(fields.title).trim()) {
      res.status(400).json({ message: "title cannot be empty" });
      return;
    }
    if (fields.slug !== undefined) {
      fields.slug = await uniqueSlug(String(fields.slug), String(id));
    }

    const article = await Article.findByIdAndUpdate(id, { $set: fields }, { new: true, runValidators: true }).select("-__v");
    if (!article) {
      res.status(404).json({ message: "Article not found" });
      return;
    }
    res.json({ data: article });
  } catch (error) {
    next(error);
  }
}

// DELETE /api/articles/:id  (admin)
export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      res.status(404).json({ message: "Article not found" });
      return;
    }
    const deleted = await Article.findByIdAndDelete(id);
    if (!deleted) {
      res.status(404).json({ message: "Article not found" });
      return;
    }
    res.json({ data: { id, deleted: true } });
  } catch (error) {
    next(error);
  }
}
