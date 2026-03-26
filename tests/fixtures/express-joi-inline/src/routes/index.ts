// @ts-nocheck
import { Router } from "express";

import { searchCatalog } from "../controllers/catalog-controller";

const router = Router();

router.post("/catalog/search", searchCatalog);

export { router };
