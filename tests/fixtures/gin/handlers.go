package main

import "github.com/gin-gonic/gin"

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
}

func getUser(c *gin.Context) {
}

func AuthMiddleware() gin.HandlerFunc {
	return nil
}
