import { Request, Response, NextFunction } from "express";
import { Article } from "../models/Article";

// GET /api/articles
export async function getArticles(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 12);
    const skip = (page - 1) * limit;
    const source = (req.query.source as string) || "drjuangarza";
    const search = (req.query.search as string) || "";

    const query: Record<string, unknown> = { isPublished: true, source };

    if (search) {
      query.$text = { $search: search };
    }

    const [articles, total] = await Promise.all([
      Article.find(query)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .select("-content -__v"),
      Article.countDocuments(query),
    ]);

    res.json({
      data: articles,
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

// GET /api/articles/:slug
export async function getArticleBySlug(req: Request, res: Response, next: NextFunction) {
  try {
    const { slug } = req.params;
    const article = await Article.findOne({ slug, isPublished: true }).select("-__v");

    if (!article) {
      res.status(404).json({ message: "Article not found" });
      return;
    }

    res.json({ data: article });
  } catch (error) {
    next(error);
  }
}
