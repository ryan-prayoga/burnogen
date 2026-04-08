<?php

use App\Http\Controllers\PaginationController;
use Illuminate\Support\Facades\Route;

Route::prefix('api')->group(function () {
    Route::get('/projects/simple', [PaginationController::class, 'simple']);
    Route::get('/projects/cursor', [PaginationController::class, 'cursor']);
    Route::get('/projects/merged', [PaginationController::class, 'merged']);
    Route::get('/projects/collection-class', [PaginationController::class, 'collectionClass']);
    Route::get('/projects/collection-auto', [PaginationController::class, 'collectionAuto']);
    Route::get('/projects/collection-method', [PaginationController::class, 'collectionMethod']);
    Route::get('/projects/collection-wrapped', [PaginationController::class, 'collectionWrapped']);
    Route::get('/projects/collection-mapped', [PaginationController::class, 'collectionMapped']);
    Route::get('/projects/collection-filtered', [PaginationController::class, 'collectionFiltered']);
    Route::get('/projects/collection-through', [PaginationController::class, 'collectionThrough']);
    Route::get('/projects/collection-closure', [PaginationController::class, 'collectionClosure']);
});
