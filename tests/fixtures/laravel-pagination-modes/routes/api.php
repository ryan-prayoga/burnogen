<?php

use App\Http\Controllers\PaginationController;
use Illuminate\Support\Facades\Route;

Route::prefix('api')->group(function () {
    Route::get('/projects/simple', [PaginationController::class, 'simple']);
    Route::get('/projects/cursor', [PaginationController::class, 'cursor']);
    Route::get('/projects/merged', [PaginationController::class, 'merged']);
});
