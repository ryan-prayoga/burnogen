// @ts-nocheck
import Joi from "joi";
import type { Request, Response } from "express";

import {
  sendConflict,
  sendCreated,
  sendNotFound,
  sendValidationError,
} from "../helpers/response";

interface CreateUserDto {
  name: string;
  email: string;
  age?: number;
  role?: string;
  price?: string;
  active?: string | boolean;
  tags?: string[];
}

interface UserQuery {
  search?: string;
  page?: string;
  limit?: string;
  order?: string;
}

const createUserSchema = Joi.object({
  name: Joi.string().required().max(255),
  email: Joi.string().email().required(),
  age: Joi.number().integer().min(18).default(18),
  role: Joi.string().valid("user", "admin").default("user"),
  status: Joi.string().valid("active", "inactive").default("active"),
  tags: Joi.array().items(Joi.string()).default([]),
});

export async function createUser(
  req: Request<Record<string, never>, unknown, CreateUserDto, UserQuery>,
  res: Response,
) {
  const { error } = createUserSchema.validate(req.body);
  const { name, email, age = 18, role = "user", tags = [] } = req.body;
  const search = req.query.search;
  const { page: currentPage = 1, limit: pageSize = 10, order = "asc" } = req.query;
  const price = parseFloat(req.body.price);
  const active = req.body.active === "true" || req.body.active === true;
  const traceId = req.headers["x-trace-id"] ?? req.get("X-Trace-Id");
  const authorization = req.get("Authorization");

  if (error || !name || !email) {
    return sendValidationError(res, { name: "required", email: "required" });
  }

  if (search === "exists") {
    return sendConflict(res, "Email already exists");
  }

  return sendCreated(res, {
    id: 1,
    name,
    email,
    age,
    role,
    page: currentPage,
    limit: pageSize,
    search,
    order,
    price,
    active,
    tags,
    traceId,
    authorization,
  });
}

export function showUser(req, res) {
  const { id } = req.params;
  const include = req.query.include;

  if (id === "404") {
    return sendNotFound(res, `User ${id} not found`);
  }

  return res.status(200).json({
    data: {
      id,
      name: "Jane Doe",
      include,
    },
  });
}

export function getMe(_req, res) {
  return res.json({
    data: {
      id: 1,
      email: "user@example.com",
    },
  });
}

export function getProfile(req, res) {
  const auth = req.headers.authorization;

  return res.json({
    profile: {
      auth,
    },
  });
}

export function updateProfile(req, res) {
  const displayName = req.body["displayName"];
  const newsletter = req.body.newsletter === "true" || req.body.newsletter === true;

  return res.status(200).json({
    message: "updated",
    data: {
      displayName,
      newsletter,
    },
  });
}

export function deleteProfile(_req, res) {
  return res.sendStatus(204);
}

export function impersonateUser(_req, res) {
  return res.status(204).send("ok");
}
