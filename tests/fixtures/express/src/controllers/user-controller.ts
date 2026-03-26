// @ts-nocheck
import { sendCreated } from "../responses/user-response";

export async function createUser(req, res) {
  const { name, email, age = 18 } = req.body;
  const { page: currentPage = 1 } = req.query;
  const traceId = req.headers["x-trace-id"] ?? req.get("X-Trace-Id");

  return sendCreated(res, {
    id: 1,
    name,
    email,
    age,
    page: currentPage,
    traceId,
  });
}

export function showUser(req, res) {
  const { id } = req.params;

  return res.json({
    data: {
      id,
      name: "Jane Doe",
    },
  });
}
