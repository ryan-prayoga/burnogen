package main

import "github.com/labstack/echo/v4"

type CreateOrderRequest struct {
	Total      int    `json:"total" validate:"required"`
	CustomerID string `json:"json_customer_id" validate:"required"`
}

func createOrder(c echo.Context) error {
	var req CreateOrderRequest
	if err := c.Bind(&req); err != nil {
		return err
	}
	return nil
}

func JWTMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return next
}
