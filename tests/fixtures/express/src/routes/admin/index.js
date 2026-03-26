const { Router } = require("express");

const userRouter = require("./users");
const { authorize, requireAuth } = require("../../middleware/auth");

const router = Router();

router.use(requireAuth);
router.use("/admin/users", authorize("admin"), userRouter);

module.exports = router;
