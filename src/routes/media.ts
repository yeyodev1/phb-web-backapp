import { Router } from "express";
import { upload, serve } from "../controllers/media.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireAdmin } from "../middlewares/admin.middleware";

const router = Router();

router.get("/:id", serve);
router.post("/", authMiddleware, requireAdmin, upload);

export default router;
