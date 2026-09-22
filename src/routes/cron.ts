import { Router } from "express";
import { cronTranslateBacklog, translationHealth } from "../controllers/cron.controller";

const router = Router();

router.get("/translate-backlog", cronTranslateBacklog);
router.get("/health", translationHealth);

export default router;
