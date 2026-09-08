import { Router } from "express";
import { getArticles, getArticleBySlug } from "../controllers/article.controller";
import { adminList, adminGet, create, update, remove } from "../controllers/articleAdmin.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireAdmin } from "../middlewares/admin.middleware";

const router = Router();

// Público
router.get("/", getArticles);

// Admin (debe declararse antes de "/:slug" para que "admin" no se tome como slug)
router.get("/admin", authMiddleware, requireAdmin, adminList);
router.get("/admin/:id", authMiddleware, requireAdmin, adminGet);
router.post("/", authMiddleware, requireAdmin, create);
router.put("/:id", authMiddleware, requireAdmin, update);
router.delete("/:id", authMiddleware, requireAdmin, remove);

// Público
router.get("/:slug", getArticleBySlug);

export default router;
