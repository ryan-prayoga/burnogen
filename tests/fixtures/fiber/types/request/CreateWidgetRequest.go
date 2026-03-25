package request

type CreateWidgetRequest struct {
	Name string `json:"name" validate:"required"`
	Page int    `query:"page"`
}
