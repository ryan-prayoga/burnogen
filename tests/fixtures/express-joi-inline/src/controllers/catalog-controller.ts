// @ts-nocheck
import Joi from "joi";

export function searchCatalog(req, res) {
  const { error } = Joi.object().keys({
    filters: Joi.object({
      status: Joi.string().valid("draft", "published").required(),
      featured: Joi.boolean().default(false),
    }).required(),
    include: Joi.array().items(Joi.string()).default([]),
    page: Joi.number().integer().min(1).default(1),
  }).validate(req.body);

  if (error) {
    return res.status(422).json({
      error: error.message,
    });
  }

  return res.json({
    ok: true,
  });
}
