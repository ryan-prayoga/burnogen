// @ts-nocheck
import { Router } from "express";

import { getUserPost } from "../controllers/post-controller";

const router = Router();

router.get("/:postId", getUserPost);

export { router };
