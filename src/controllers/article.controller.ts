import { Request, Response, NextFunction } from "express";
import { Article } from "../models/Article";
import {
  credsFromRequest,
  localizeListItems,
  resolveDetailTranslation,
} from "../services/articleTranslation.service";

// Solo "en" activa la traducción; cualquier otro valor (o ausencia) responde como siempre.
function wantsEnglish(req: Request): boolean {
  return req.query.lang === "en";
}

// GET /api/articles  (?lang=en → títulos/extractos en inglés cuando existan)
export async function getArticles(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 12);
    const skip = (page - 1) * limit;
    const source = (req.query.source as string) || "drjuangarza";
    const search = (req.query.search as string) || "";
    const english = wantsEnglish(req);

    const query: Record<string, unknown> = { isPublished: true, source };

    if (search) {
      query.$text = { $search: search };
    }

    const [articles, total] = await Promise.all([
      Article.find(query)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .select(english ? "-content -__v -translations.en.content" : "-content -__v -translations"),
      Article.countDocuments(query),
    ]);

    const data = english
      ? await localizeListItems(articles.map((a) => a.toJSON() as any), credsFromRequest(req))
      : articles;

    res.json({
      data,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
}

// GET /api/articles/:slug  (?lang=en → artículo en inglés si ya está traducido;
// si no, devuelve el español con translation.status "pending" y traduce en segundo plano)
export async function getArticleBySlug(req: Request, res: Response, next: NextFunction) {
  try {
    const { slug } = req.params;
    const english = wantsEnglish(req);
    const article = await Article.findOne({ slug, isPublished: true }).select(english ? "-__v" : "-__v -translations");

    if (!article) {
      res.status(404).json({ message: "Article not found" });
      return;
    }

    if (!english) {
      res.json({ data: article });
      return;
    }

    const doc = article.toJSON() as any;
    const { translations: _omit, ...base } = doc;
    const t = resolveDetailTranslation(doc, credsFromRequest(req));

    if (t.status === "ready" && t.en) {
      res.json({
        data: {
          ...base,
          title: t.en.title,
          excerpt: t.en.excerpt ?? base.excerpt,
          content: t.en.content,
          lang: "en",
          translation: { status: "ready", translatedAt: t.en.translatedAt || null },
        },
      });
      return;
    }

    res.json({ data: { ...base, lang: "es", translation: { status: t.status } } });
  } catch (error) {
    next(error);
  }
}
