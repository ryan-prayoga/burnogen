package main

import "github.com/labstack/echo/v4"

func register(e *echo.Echo) {
	api := e.Group("/api", JWTMiddleware)
	api.POST("/orders", createOrder)
}
