import { Router } from "express";
import { cronTranslateBacklog, translationHealth } from "../controllers/cron.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireAdmin } from "../middlewares/admin.middleware";

const router = Router();

router.get("/translate-backlog", cronTranslateBacklog);
// Diagnóstico solo para administradores (revela si hay CRON_SECRET y credenciales)
router.get("/health", authMiddleware, requireAdmin, translationHealth);

export default router;
