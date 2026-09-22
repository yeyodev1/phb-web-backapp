import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { Article } from "../models/Article";
import { slugify } from "../utils/slugify";
import { isFullFresh } from "../utils/translation.helpers";
import {
  credsFromRequest,
  processBacklog,
  scheduleTranslation,
  translateArticleNow,
  translationInfo,
} from "../services/articleTranslation.service";
import { hasLlmCredentials } from "../services/translation.service";

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

// Añade el estado de la traducción al inglés (para el admin).
function withTranslation(article: any) {
  const json = typeof article?.toJSON === "function" ? article.toJSON() : article;
  return { ...json, translation: translationInfo(json) };
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

// Publicados sin traducción al inglés vigente (para el botón "Traducir pendientes").
// Hace falta el contenido para calcular el hash: se cachea 60 s por instancia.
let statsCache: { at: number; value: { total: number; remaining: number } } | null = null;
async function backlogStats() {
  if (statsCache && Date.now() - statsCache.at < 60_000) return statsCache.value;
  const docs = await Article.find({ isPublished: true })
    .select("title excerpt content translations.en.status translations.en.sourceHash translations.en.title")
    .lean();
  const remaining = docs.filter((d) => !isFullFresh(d, d.translations?.en)).length;
  const value = { total: docs.length, remaining };
  statsCache = { at: Date.now(), value };
  return value;
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
      // content se necesita para saber si la traducción está al día; se quita de la respuesta
      Article.find(query).sort({ date: -1 }).skip(skip).limit(limit).select("-__v -translations.en.content -translations.en.excerpt").lean(),
      Article.countDocuments(query),
    ]);

    const data = articles.map((a: any) => {
      const { content: _content, ...rest } = a;
      return { ...rest, translation: translationInfo(a) };
    });

    const translationStats = await backlogStats().catch(() => undefined);
    res.json({ data, pagination: { page, limit, total, pages: Math.ceil(total / limit) }, translationStats });
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
    res.json({ data: withTranslation(article) });
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
    if (article.isPublished) scheduleTranslation(String(article._id), credsFromRequest(req));
    res.status(201).json({ data: withTranslation(article) });
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

    // Si cambia el español, se reinicia el contador de intentos fallidos (texto nuevo, intentos nuevos)
    const spanishChanged = fields.title !== undefined || fields.excerpt !== undefined || fields.content !== undefined;
    const ops: Record<string, unknown> = { $set: fields };
    if (spanishChanged) ops.$unset = { "translations.en.attempts": "" };
    const article = await Article.findByIdAndUpdate(id, ops, { new: true, runValidators: true }).select("-__v");
    if (!article) {
      res.status(404).json({ message: "Article not found" });
      return;
    }
    // Si el español cambió (o se publicó) y la traducción no está al día, se regenera en segundo plano
    if (article.isPublished && !isFullFresh(article, article.translations?.en)) {
      scheduleTranslation(String(article._id), credsFromRequest(req));
    }
    res.json({ data: withTranslation(article) });
  } catch (error) {
    next(error);
  }
}

// POST /api/articles/admin/:id/translate  (admin) — fuerza (re)traducir y espera el resultado
export async function forceTranslate(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      res.status(404).json({ message: "Article not found" });
      return;
    }
    const creds = credsFromRequest(req);
    if (!hasLlmCredentials(creds)) {
      res.status(503).json({ message: "Traducción no disponible: faltan credenciales del LLM" });
      return;
    }
    const outcome = await translateArticleNow(String(id), creds, { force: true });
    if (outcome.status === "skipped" && outcome.reason === "not-found") {
      res.status(404).json({ message: "Article not found" });
      return;
    }
    if (outcome.status === "skipped" && outcome.reason === "locked") {
      res.status(409).json({ message: "Ya hay una traducción en curso para este artículo" });
      return;
    }
    if (outcome.status === "skipped") {
      // "changed": el español cambió justo mientras se reclamaba; cualquier otro caso tampoco tradujo
      res.status(409).json({
        message: outcome.reason === "changed"
          ? "El artículo cambió mientras se iniciaba la traducción; vuelve a intentarlo"
          : "No se pudo iniciar la traducción; vuelve a intentarlo",
      });
      return;
    }
    const article = await Article.findById(id).select("-__v");
    const data = withTranslation(article);
    if (outcome.status === "failed") {
      res.status(502).json({ message: `La traducción falló: ${outcome.error}`, data });
      return;
    }
    res.json({ data });
  } catch (error) {
    next(error);
  }
}

// POST /api/articles/admin/translate-backlog?limit=N  (admin) — traduce hasta N (máx 10)
export async function translateBacklog(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit as string) || 3));
    const result = await processBacklog(limit, credsFromRequest(req));
    statsCache = null;
    res.json({ data: result });
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
