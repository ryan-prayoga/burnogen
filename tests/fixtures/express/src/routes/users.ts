// @ts-nocheck
import { Router, type Request, type Response } from "express";

import {
  createUser,
  deleteProfile,
  getMe,
  getProfile,
  impersonateUser,
  showUser,
  updateProfile,
} from "../controllers/user-controller";
import { authenticate, authorize, verifyToken } from "../middleware/auth";

const router = Router();

router.use(authenticate);
router.route("/")
  .post(createUser);

router.route("/profile")
  .get(getProfile)
  .put(updateProfile)
  .delete(deleteProfile);

router.get("/me", getMe);
router.get<{ id: string }, unknown, never, { include?: string }>(
  "/:id",
  showUser,
);
router.post("/impersonate", verifyToken, authorize("admin"), impersonateUser);

export { router };
