package main

import "github.com/gofiber/fiber/v2"

func register(app *fiber.App) {
	api := app.Group("/api", AuthMiddleware)
	api.Post("/widgets", RequireRole([]int{1, 2}), createWidget)
}
