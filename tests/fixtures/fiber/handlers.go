package main

import (
	"example.com/fiberapp/types/request"

	"github.com/gofiber/fiber/v2"
)

var responseHelper ResponseHelper

func createWidget(c *fiber.Ctx) error {
	var req request.CreateWidgetRequest
	if err := c.BodyParser(&req); err != nil {
		return err
	}
	token := c.Get("TTOKEN")
	return responseHelper.SuccessResponse(c, "widget created", fiber.Map{
		"name":  req.Name,
		"page":  req.Page,
		"token": token,
	})
}

func AuthMiddleware(c *fiber.Ctx) error {
	return nil
}

func RequireRole(ids []int) fiber.Handler {
	return nil
}
