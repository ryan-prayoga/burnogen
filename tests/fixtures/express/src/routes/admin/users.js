const { Router } = require("express");

const { createAdminUser, listAdminUsers } = require("../../controllers/admin/user-controller");

const router = Router();

router.get("/", listAdminUsers);
router.post("/", createAdminUser);

module.exports = router;
