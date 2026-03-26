// @ts-nocheck
import { Router } from "express";

import { listReports } from "../controllers/report-controller";
import { checkPermission } from "../middleware/security";

const router = Router();

router.get("/reports", checkPermission("reports.read"), listReports);

export { router };
