<?php

use App\Http\Controllers\SessionController;
use App\Http\Controllers\UserController;
use Illuminate\Support\Facades\Route;

Route::prefix('api')->group(function () {
    Route::post('/login', [SessionController::class, 'store']);

    Route::middleware('auth:sanctum')->group(function () {
        Route::get('/users', [UserController::class, 'index']);
        Route::post('/users', [UserController::class, 'store']);
    });

    Route::apiResource('projects', UserController::class)->only(['index', 'show']);
});
