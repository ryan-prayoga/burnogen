// @ts-nocheck
export function sendCreated(res, payload) {
  return res.status(201).json({
    message: "user created",
    data: payload,
  });
}
