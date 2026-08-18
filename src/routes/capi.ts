import { Router } from "express";
import { track, status } from "../controllers/capi.controller";

const router = Router();

router.post("/track", track);
router.get("/status", status);

export default router;
