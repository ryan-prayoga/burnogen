<?php

use App\Http\Controllers\Admin\UserController as AdminUserController;
use App\Http\Controllers\Api\UserController as ApiUserController;
use App\Http\Controllers\StatusController;
use Illuminate\Support\Facades\Route;

Route::prefix('api')
    ->middleware(['auth:sanctum', 'verified'])
    ->group(function () {
        Route::controller(ApiUserController::class)
            ->prefix('users')
            ->group(function () {
                Route::get('/', 'index');
                Route::post('/', 'store');
            });

        Route::prefix('admin')
            ->controller(AdminUserController::class)
            ->group(function () {
                Route::get('users', 'index');
                Route::post('users', 'store');
            });

        Route::get('status', StatusController::class);
    });
