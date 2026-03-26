package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type CreateUserRequest struct {
	Name  string `json:"name" binding:"required"`
	Email string `json:"email" binding:"required"`
	Age   int    `json:"age"`
}

func createUser(c *gin.Context) {
	var req CreateUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"message": "user created",
		"data": gin.H{
			"name":  req.Name,
			"email": req.Email,
			"age":   req.Age,
		},
	})
}

func getUser(c *gin.Context) {
	id := c.Param("id")

	c.JSON(http.StatusOK, gin.H{
		"data": gin.H{
			"id":   id,
			"name": "Jane Doe",
		},
	})
}

func AuthMiddleware() gin.HandlerFunc {
	return nil
}
