// @ts-nocheck
import express from "express";

import { router as apiRouter } from "./routes";

const adminRouter = require("./routes/admin");

const app = express();

app.use(express.json());
app.use("/api", apiRouter);
app.use("/api", adminRouter);

export default app;
