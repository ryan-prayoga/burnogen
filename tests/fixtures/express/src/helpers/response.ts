// @ts-nocheck
export const sendSuccess = (res, data, status = 200) => res.status(status).json({
  success: true,
  data,
});

export const sendCreated = (res, data) => sendSuccess(res, data, 201);

export const sendError = (res, message, status = 400) => res.status(status).json({
  success: false,
  error: message,
});

export const sendValidationError = (res, errors) => res.status(422).json({ errors });

export const sendConflict = (res, message) => sendError(res, message, 409);

export const sendNotFound = (res, message = "Not found") => sendError(res, message, 404);
