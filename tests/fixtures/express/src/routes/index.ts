// @ts-nocheck
import { Router } from "express";

import { router as authRouter } from "./auth";
import { v1Router } from "./v1";

const router = Router();

router.use("/auth", authRouter);
router.use("/v1", v1Router);

export { router };
