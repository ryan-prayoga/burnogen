package main

import "github.com/gin-gonic/gin"

func register(router *gin.Engine) {
	api := router.Group("/api")
	api.Use(AuthMiddleware())
	api.POST("/users", createUser)
	api.GET("/users/:id", getUser)
}
