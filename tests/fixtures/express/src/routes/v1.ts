// @ts-nocheck
import { Router } from "express";

import { authenticate } from "../middleware/auth";
import { router as postRouter } from "./posts";
import { router as userRouter } from "./users";

const v1Router = Router();

v1Router.use("/users", userRouter);
v1Router.use("/users/:id/posts", authenticate, postRouter);

export { v1Router };
