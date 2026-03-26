package main

import (
	"net/http"

	"github.com/labstack/echo/v4"
)

type CreateOrderRequest struct {
	Total      int    `json:"total" validate:"required"`
	CustomerID string `json:"json_customer_id" validate:"required"`
}

func createOrder(c echo.Context) error {
	var req CreateOrderRequest
	if err := c.Bind(&req); err != nil {
		return err
	}

	token := c.Request().Header.Get("TTOKEN")
	return c.JSON(http.StatusCreated, map[string]any{
		"message": "order created",
		"data": map[string]any{
			"total":      req.Total,
			"customerId": req.CustomerID,
			"token":      token,
		},
	})
}

func JWTMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return next
}
